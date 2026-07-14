// A symlink-confined 9p file server backend, replacing hugelgupf/p9's fsimpl/localfs. localfs opens
// files with a raw os.OpenFile that FOLLOWS symlinks, so a symlink or Windows junction inside a
// shared policy root that points outside it (e.g. into C:\Users\victim\.ssh) lets the untrusted
// guest — speaking raw 9p2000.L over vsock — read or write arbitrary HOST files, defeating
// writeConfine/readDeny. virtiofsd confines symlink resolution on the mac/Linux path; this backend
// restores that guarantee on Windows by routing EVERY filesystem operation through os.Root, whose
// methods refuse any path (or symlink target) that escapes the root, TOCTOU-safe (the check and the
// open are one operation on the same descriptor). No build tag — os.Root is cross-platform, so the
// escape-rejection property is unit-tested on the dev host.

package main

import (
	"hash/fnv"
	"io"
	"os"
	"path"
	"strings"
	"time"

	"github.com/hugelgupf/p9/fsimpl/templatefs"
	"github.com/hugelgupf/p9/linux"
	"github.com/hugelgupf/p9/p9"
)

// confinedAttacher hands out the root file; the *os.Root is shared by every file in the tree.
type confinedAttacher struct {
	root *os.Root
}

func newConfinedAttacher(dir string) (*confinedAttacher, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	return &confinedAttacher{root: root}, nil
}

func (a *confinedAttacher) Attach() (p9.File, error) {
	return &confinedFile{root: a.root, rel: "."}, nil
}

// confinedFile is one file/dir within the root, addressed by its root-relative path. All operations
// go through os.Root, so no path — including any symlink component — can escape the shared dir.
type confinedFile struct {
	templatefs.XattrUnimplemented
	templatefs.NotLockable
	root *os.Root
	rel  string   // slash-clean path relative to the root ("." is the root itself)
	file *os.File // set between Open/Create and Close
}

var _ p9.File = (*confinedFile)(nil)

// safeName rejects the components 9p already forbids, defense-in-depth against a hand-rolled client.
func safeName(name string) bool {
	return name != "" && name != "." && name != ".." && !strings.ContainsAny(name, `/\`)
}

func (f *confinedFile) child(name string) string {
	if f.rel == "." {
		return name
	}
	return path.Join(f.rel, name)
}

// qidFor derives a stable-per-path QID from an Lstat of the (confined) relative path.
func (f *confinedFile) qidFor(rel string) (p9.QID, os.FileInfo, error) {
	fi, err := f.root.Lstat(rel)
	if err != nil {
		return p9.QID{}, nil, err
	}
	h := fnv.New64a()
	_, _ = h.Write([]byte(rel))
	return p9.QID{Type: modeToQIDType(fi.Mode()), Path: h.Sum64()}, fi, nil
}

func modeToQIDType(m os.FileMode) p9.QIDType {
	switch {
	case m&os.ModeSymlink != 0:
		return p9.TypeSymlink
	case m.IsDir():
		return p9.TypeDir
	default:
		return p9.TypeRegular
	}
}

func (f *confinedFile) Walk(names []string) ([]p9.QID, p9.File, error) {
	if len(names) == 0 {
		return nil, &confinedFile{root: f.root, rel: f.rel}, nil
	}
	qids := make([]p9.QID, 0, len(names))
	cur := f.rel
	for _, name := range names {
		if !safeName(name) {
			return nil, nil, linux.EINVAL
		}
		cur = joinRel(cur, name)
		// Lstat through os.Root: rejects any component that escapes the root (absolute or ..-through
		// -symlink), so a walk can never land a fid outside the shared dir.
		qid, _, err := (&confinedFile{root: f.root, rel: cur}).qidFor(cur)
		if err != nil {
			return nil, nil, err
		}
		qids = append(qids, qid)
	}
	return qids, &confinedFile{root: f.root, rel: cur}, nil
}

func joinRel(base, name string) string {
	if base == "." {
		return name
	}
	return path.Join(base, name)
}

func (f *confinedFile) WalkGetAttr(names []string) ([]p9.QID, p9.File, p9.AttrMask, p9.Attr, error) {
	qids, file, err := f.Walk(names)
	if err != nil {
		return nil, nil, p9.AttrMask{}, p9.Attr{}, err
	}
	_, mask, attr, err := file.GetAttr(p9.AttrMaskAll)
	if err != nil {
		return nil, nil, p9.AttrMask{}, p9.Attr{}, err
	}
	return qids, file, mask, attr, nil
}

func (f *confinedFile) GetAttr(_ p9.AttrMask) (p9.QID, p9.AttrMask, p9.Attr, error) {
	qid, fi, err := f.qidFor(f.rel)
	if err != nil {
		return p9.QID{}, p9.AttrMask{}, p9.Attr{}, err
	}
	return qid, p9.AttrMaskAll, infoToAttr(fi), nil
}

// infoToAttr fills the portable subset of p9.Attr from an os.FileInfo (mode/size/mtime). uid/gid and
// the finer time fields aren't portably available from FileInfo; the guest workload runs as a single
// user and only needs content + type + size, so leaving them zero is correct for this use.
func infoToAttr(fi os.FileInfo) p9.Attr {
	m := fi.Mode()
	mode := p9.FileMode(m.Perm())
	switch {
	case m&os.ModeSymlink != 0:
		mode |= p9.ModeSymlink
	case m.IsDir():
		mode |= p9.ModeDirectory
	default:
		mode |= p9.ModeRegular
	}
	secs := uint64(fi.ModTime().Unix())
	return p9.Attr{
		Mode:         mode,
		Size:         uint64(fi.Size()),
		NLink:        1,
		ATimeSeconds: secs,
		MTimeSeconds: secs,
		CTimeSeconds: secs,
	}
}

func (f *confinedFile) Open(mode p9.OpenFlags) (p9.QID, uint32, error) {
	file, err := f.root.OpenFile(f.rel, osFlags(mode), 0)
	if err != nil {
		return p9.QID{}, 0, err
	}
	f.file = file
	qid, _, err := f.qidFor(f.rel)
	if err != nil {
		_ = file.Close()
		return p9.QID{}, 0, err
	}
	return qid, 0, nil
}

// osFlags maps p9 open flags to os flags. p9.OpenFlags carries only the access mode (the low 2 bits),
// so there is no O_TRUNC/O_APPEND passthrough to worry about; the read-only wrapper (serve9p.go)
// rejects write modes before this is reached on --ro shares.
func osFlags(mode p9.OpenFlags) int {
	switch mode & p9.OpenFlagsModeMask {
	case p9.WriteOnly:
		return os.O_WRONLY
	case p9.ReadWrite:
		return os.O_RDWR
	default:
		return os.O_RDONLY
	}
}

func (f *confinedFile) Create(name string, mode p9.OpenFlags, perm p9.FileMode, _ p9.UID, _ p9.GID) (p9.File, p9.QID, uint32, error) {
	if !safeName(name) {
		return nil, p9.QID{}, 0, linux.EINVAL
	}
	rel := f.child(name)
	file, err := f.root.OpenFile(rel, osFlags(mode)|os.O_CREATE|os.O_EXCL, os.FileMode(perm.Permissions()))
	if err != nil {
		return nil, p9.QID{}, 0, err
	}
	child := &confinedFile{root: f.root, rel: rel, file: file}
	qid, _, err := f.qidFor(rel)
	if err != nil {
		_ = file.Close()
		return nil, p9.QID{}, 0, err
	}
	return child, qid, 0, nil
}

func (f *confinedFile) Mkdir(name string, perm p9.FileMode, _ p9.UID, _ p9.GID) (p9.QID, error) {
	if !safeName(name) {
		return p9.QID{}, linux.EINVAL
	}
	rel := f.child(name)
	if err := f.root.Mkdir(rel, os.FileMode(perm.Permissions())); err != nil {
		return p9.QID{}, err
	}
	qid, _, err := f.qidFor(rel)
	return qid, err
}

func (f *confinedFile) Symlink(oldName string, newName string, _ p9.UID, _ p9.GID) (p9.QID, error) {
	if !safeName(newName) {
		return p9.QID{}, linux.EINVAL
	}
	// os.Root refuses to FOLLOW an escaping link at open time, but it still lets one be CREATED with
	// an absolute target — which would leave a host-resolvable trap for any other process reading the
	// shared dir. Reject absolute targets up front (the guest is Linux, so its `/…` targets aren't
	// caught by the host's filepath.IsAbs on Windows; check both forms explicitly).
	if isAbsTarget(oldName) {
		return p9.QID{}, linux.EPERM
	}
	rel := f.child(newName)
	if err := f.root.Symlink(oldName, rel); err != nil {
		return p9.QID{}, err
	}
	qid, _, err := f.qidFor(rel)
	return qid, err
}

// isAbsTarget reports whether a symlink target is absolute in EITHER a POSIX (guest) or Windows
// (host) sense — a leading slash/backslash, or a `C:` drive prefix.
func isAbsTarget(t string) bool {
	if t == "" {
		return false
	}
	if t[0] == '/' || t[0] == '\\' {
		return true
	}
	return len(t) >= 2 && t[1] == ':' &&
		((t[0] >= 'A' && t[0] <= 'Z') || (t[0] >= 'a' && t[0] <= 'z'))
}

func (f *confinedFile) Link(target p9.File, newName string) error {
	t, ok := target.(*confinedFile)
	if !ok || !safeName(newName) {
		return linux.EINVAL
	}
	return f.root.Link(t.rel, f.child(newName))
}

// Mknod (device/fifo nodes) isn't supported by os.Root and has no place in a shared code directory.
func (f *confinedFile) Mknod(_ string, _ p9.FileMode, _ uint32, _ uint32, _ p9.UID, _ p9.GID) (p9.QID, error) {
	return p9.QID{}, linux.ENOSYS
}

func (f *confinedFile) UnlinkAt(name string, _ uint32) error {
	if !safeName(name) {
		return linux.EINVAL
	}
	return f.root.Remove(f.child(name))
}

func (f *confinedFile) RenameAt(oldName string, newDir p9.File, newName string) error {
	nd, ok := newDir.(*confinedFile)
	if !ok || !safeName(oldName) || !safeName(newName) {
		return linux.EINVAL
	}
	return f.root.Rename(f.child(oldName), nd.child(newName))
}

func (f *confinedFile) Rename(newDir p9.File, newName string) error {
	nd, ok := newDir.(*confinedFile)
	if !ok || !safeName(newName) {
		return linux.EINVAL
	}
	return f.root.Rename(f.rel, nd.child(newName))
}

func (f *confinedFile) Renamed(newDir p9.File, newName string) {
	if nd, ok := newDir.(*confinedFile); ok {
		f.rel = nd.child(newName)
	}
}

func (f *confinedFile) Readlink() (string, error) {
	return f.root.Readlink(f.rel)
}

func (f *confinedFile) SetAttr(valid p9.SetAttrMask, attr p9.SetAttr) error {
	if valid.Size {
		file, err := f.root.OpenFile(f.rel, os.O_RDWR, 0)
		if err != nil {
			return err
		}
		defer file.Close()
		if err := file.Truncate(int64(attr.Size)); err != nil {
			return err
		}
	}
	if valid.Permissions {
		if err := f.root.Chmod(f.rel, os.FileMode(attr.Permissions.Permissions())); err != nil {
			return err
		}
	}
	if valid.ATime || valid.MTime {
		now := time.Now()
		at, mt := now, now
		if valid.ATime && !valid.ATimeNotSystemTime {
			at = time.Unix(int64(attr.ATimeSeconds), int64(attr.ATimeNanoSeconds))
		}
		if valid.MTime && !valid.MTimeNotSystemTime {
			mt = time.Unix(int64(attr.MTimeSeconds), int64(attr.MTimeNanoSeconds))
		}
		if err := f.root.Chtimes(f.rel, at, mt); err != nil {
			return err
		}
	}
	return nil
}

func (f *confinedFile) ReadAt(p []byte, offset int64) (int, error) {
	if f.file == nil {
		return 0, linux.EBADF
	}
	n, err := f.file.ReadAt(p, offset)
	if err == io.EOF {
		return n, nil
	}
	return n, err
}

func (f *confinedFile) WriteAt(p []byte, offset int64) (int, error) {
	if f.file == nil {
		return 0, linux.EBADF
	}
	return f.file.WriteAt(p, offset)
}

func (f *confinedFile) Readdir(offset uint64, count uint32) (p9.Dirents, error) {
	dir, err := f.root.Open(f.rel)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	infos, err := dir.Readdir(-1)
	if err != nil {
		return nil, err
	}
	var dirents p9.Dirents
	for i, fi := range infos {
		if uint64(i) < offset {
			continue
		}
		rel := f.child(fi.Name())
		h := fnv.New64a()
		_, _ = h.Write([]byte(rel))
		dirents = append(dirents, p9.Dirent{
			QID:    p9.QID{Type: modeToQIDType(fi.Mode()), Path: h.Sum64()},
			Offset: uint64(i) + 1,
			Type:   modeToQIDType(fi.Mode()),
			Name:   fi.Name(),
		})
		if count != 0 && uint32(len(dirents)) >= count {
			break
		}
	}
	return dirents, nil
}

func (f *confinedFile) FSync() error {
	if f.file == nil {
		return nil
	}
	return f.file.Sync()
}

func (f *confinedFile) StatFS() (p9.FSStat, error) {
	// v9fs tolerates a zeroed statfs; os.Root exposes no portable statfs and the guest doesn't rely
	// on accurate free-space figures for a shared code dir.
	return p9.FSStat{Type: 0x01021997 /* V9FS_MAGIC */, BlockSize: 4096, NameLength: 255}, nil
}

func (f *confinedFile) Close() error {
	if f.file != nil {
		err := f.file.Close()
		f.file = nil
		return err
	}
	return nil
}
