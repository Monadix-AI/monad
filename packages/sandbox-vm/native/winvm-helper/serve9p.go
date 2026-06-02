//go:build windows

// The 9p file server backing the VM's policy-root mounts — the Windows replacement for virtio-fs
// (no virtiofsd on Windows hosts; QEMU's 9p server never merged there either). Same shape as
// podman machine's hyperv volume sharing (hugelgupf/p9 over hvsock), with two hardenings:
//   • the listener binds a specific VMID, never the wildcard (no cross-VM share access);
//   • --ro wraps the attacher so read-only roots are enforced HOST-side (the guest's `ro` mount
//     flag alone would leave the host trusting guest-kernel behavior for the write boundary).

package main

import (
	"flag"

	"github.com/Microsoft/go-winio"
	"github.com/hugelgupf/p9/linux"
	"github.com/hugelgupf/p9/p9"
)

// roFile denies every mutating 9p operation with EROFS while delegating reads to the wrapped file.
// Walk-produced files are re-wrapped so a client can never walk out of the read-only view.
type roFile struct {
	p9.File
}

var _ p9.File = (*roFile)(nil)

func (f *roFile) Walk(names []string) ([]p9.QID, p9.File, error) {
	qids, file, err := f.File.Walk(names)
	if err != nil {
		return nil, nil, err
	}
	return qids, &roFile{File: file}, nil
}

func (f *roFile) WalkGetAttr(names []string) ([]p9.QID, p9.File, p9.AttrMask, p9.Attr, error) {
	qids, file, mask, attr, err := f.File.WalkGetAttr(names)
	if err != nil {
		return nil, nil, p9.AttrMask{}, p9.Attr{}, err
	}
	return qids, &roFile{File: file}, mask, attr, nil
}

func (f *roFile) Open(flags p9.OpenFlags) (p9.QID, uint32, error) {
	if flags.Mode() != p9.ReadOnly {
		return p9.QID{}, 0, linux.EROFS
	}
	return f.File.Open(flags)
}

func (f *roFile) WriteAt(_ []byte, _ int64) (int, error) { return 0, linux.EROFS }
func (f *roFile) FSync() error                           { return linux.EROFS }
func (f *roFile) SetAttr(_ p9.SetAttrMask, _ p9.SetAttr) error {
	return linux.EROFS
}
func (f *roFile) Create(_ string, _ p9.OpenFlags, _ p9.FileMode, _ p9.UID, _ p9.GID) (p9.File, p9.QID, uint32, error) {
	return nil, p9.QID{}, 0, linux.EROFS
}
func (f *roFile) Mkdir(_ string, _ p9.FileMode, _ p9.UID, _ p9.GID) (p9.QID, error) {
	return p9.QID{}, linux.EROFS
}
func (f *roFile) Symlink(_ string, _ string, _ p9.UID, _ p9.GID) (p9.QID, error) {
	return p9.QID{}, linux.EROFS
}
func (f *roFile) Link(_ p9.File, _ string) error { return linux.EROFS }
func (f *roFile) Mknod(_ string, _ p9.FileMode, _ uint32, _ uint32, _ p9.UID, _ p9.GID) (p9.QID, error) {
	return p9.QID{}, linux.EROFS
}
func (f *roFile) Rename(_ p9.File, _ string) error             { return linux.EROFS }
func (f *roFile) RenameAt(_ string, _ p9.File, _ string) error { return linux.EROFS }
func (f *roFile) UnlinkAt(_ string, _ uint32) error            { return linux.EROFS }
func (f *roFile) SetXattr(_ string, _ []byte, _ p9.XattrFlags) error {
	return linux.EROFS
}
func (f *roFile) RemoveXattr(_ string) error { return linux.EROFS }

type roAttacher struct {
	p9.Attacher
}

func (a *roAttacher) Attach() (p9.File, error) {
	f, err := a.Attacher.Attach()
	if err != nil {
		return nil, err
	}
	return &roFile{File: f}, nil
}

func cmdServe9p(args []string) {
	fs := flag.NewFlagSet("serve9p", flag.ExitOnError)
	vmId := fs.String("vm-id", "", "VM GUID allowed to connect")
	port := fs.Uint("port", 0, "vsock port the guest mounts from")
	root := fs.String("root", "", "host directory to expose")
	ro := fs.Bool("ro", false, "expose read-only (enforced host-side)")
	_ = fs.Parse(args)
	if *vmId == "" || *port == 0 || *root == "" {
		fail("serve9p: --vm-id, --port and --root are required")
	}
	addr, err := hvsockAddr(*vmId, uint32(*port))
	if err != nil {
		fail("serve9p: %v", err)
	}
	l, err := winio.ListenHvsock(addr)
	if err != nil {
		fail("serve9p: listen hvsock %s:%d: %v", *vmId, *port, err)
	}
	// confinedAttacher (os.Root-backed) instead of hugelgupf/p9's localfs: localfs follows symlinks
	// out of the shared dir, which would let the untrusted guest read/write arbitrary host files
	// through a symlink or Windows junction planted in a mounted root. os.Root refuses any escape.
	base, err := newConfinedAttacher(*root)
	if err != nil {
		fail("serve9p: open root %s: %v", *root, err)
	}
	defer base.Close()
	var attacher p9.Attacher = base
	if *ro {
		attacher = &roAttacher{Attacher: attacher}
	}
	server := p9.NewServer(attacher)
	emit(map[string]any{"ready": true})
	if err := server.Serve(l); err != nil {
		fail("serve9p: %v", err)
	}
}
