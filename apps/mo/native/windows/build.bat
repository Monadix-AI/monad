@echo off
REM Windows Mo shell -- TODO. Win32 layered window (WS_EX_LAYERED|WS_EX_TOPMOST|
REM WS_EX_TOOLWINDOW) with per-pixel alpha via UpdateLayeredWindow, IDropTarget for file
REM drops, and a WinHTTP client against the daemon's /v1/mo/drop + /health, mirroring
REM native/linux. See docs/mo.md.
echo mo: Windows shell not yet implemented -- see docs/mo.md 1>&2
exit /b 1
