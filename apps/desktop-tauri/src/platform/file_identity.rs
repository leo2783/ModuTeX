// SPDX-License-Identifier: Apache-2.0
//! Platform file identity and no-follow link checking primitives.

use std::{
    fs::{self, File, OpenOptions},
    io,
    path::Path,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct FileIdentity {
    volume: u64,
    index: u64,
}

#[cfg(windows)]
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Filetime {
    _low_date_time: u32,
    _high_date_time: u32,
}

/// Shared `BY_HANDLE_FILE_INFORMATION` ABI layout for native handle identity
/// checks in this module and `watch_native`.
#[cfg(windows)]
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub(crate) struct ByHandleFileInformation {
    pub(crate) file_attributes: u32,
    _creation_time: Filetime,
    _last_access_time: Filetime,
    _last_write_time: Filetime,
    pub(crate) volume_serial_number: u32,
    _file_size_high: u32,
    _file_size_low: u32,
    _number_of_links: u32,
    pub(crate) file_index_high: u32,
    pub(crate) file_index_low: u32,
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    pub(crate) fn GetFileInformationByHandle(
        file: *mut std::ffi::c_void,
        information: *mut ByHandleFileInformation,
    ) -> i32;
}

#[cfg(windows)]
pub(crate) fn file_identity(file: &File) -> io::Result<FileIdentity> {
    use std::{mem::MaybeUninit, os::windows::io::AsRawHandle};

    let mut information = MaybeUninit::<ByHandleFileInformation>::uninit();
    // The handle is an owned File opened by this module with no-follow flags.
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) };
    if succeeded == 0 {
        return Err(io::Error::last_os_error());
    }
    let information = unsafe { information.assume_init() };
    Ok(FileIdentity {
        volume: u64::from(information.volume_serial_number),
        index: (u64::from(information.file_index_high) << 32)
            | u64::from(information.file_index_low),
    })
}

#[cfg(unix)]
pub(crate) fn file_identity(file: &File) -> io::Result<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata()?;
    Ok(FileIdentity {
        volume: meta.dev(),
        index: meta.ino(),
    })
}

#[cfg(not(any(windows, unix)))]
pub(crate) fn file_identity(_file: &File) -> io::Result<FileIdentity> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "stable handle identity unavailable",
    ))
}

pub(crate) fn is_symlink_or_reparse(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return true;
        }
    }
    false
}

#[cfg(windows)]
pub(crate) fn open_file_no_follow(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    let mut options = OpenOptions::new();
    options
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    options.open(path)
}

#[cfg(unix)]
fn unix_nofollow_flags(directory: bool) -> Option<i32> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        return Some(if directory {
            0x0002_0000 | 0x0001_0000 // O_NOFOLLOW | O_DIRECTORY
        } else {
            0x0002_0000 // O_NOFOLLOW
        });
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        return Some(if directory {
            0x0000_0100 | 0x0010_0000 // O_NOFOLLOW | O_DIRECTORY
        } else {
            0x0000_0100 // O_NOFOLLOW
        });
    }
    #[cfg(not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    )))]
    {
        let _ = directory;
        None
    }
}

#[cfg(unix)]
pub(crate) fn open_file_no_follow(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    let flags = unix_nofollow_flags(false)
        .ok_or_else(|| io::Error::new(io::ErrorKind::Unsupported, "no-follow open unavailable"))?;
    let mut options = OpenOptions::new();
    options.read(true).custom_flags(flags);
    options.open(path)
}

#[cfg(not(any(windows, unix)))]
pub(crate) fn open_file_no_follow(_path: &Path) -> io::Result<File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "no-follow open unavailable",
    ))
}

#[cfg(windows)]
pub(crate) fn open_directory_no_follow(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    let mut options = OpenOptions::new();
    options
        .read(true)
        // Omitting FILE_SHARE_DELETE pins every walked directory against
        // rename/replacement until the trusted capability is dropped.
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
    options.open(path)
}

#[cfg(unix)]
pub(crate) fn open_directory_no_follow(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    let flags = unix_nofollow_flags(true)
        .ok_or_else(|| io::Error::new(io::ErrorKind::Unsupported, "no-follow open unavailable"))?;
    let mut options = OpenOptions::new();
    options.read(true).custom_flags(flags);
    options.open(path)
}

#[cfg(not(any(windows, unix)))]
pub(crate) fn open_directory_no_follow(_path: &Path) -> io::Result<File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "no-follow directory open unavailable",
    ))
}

#[cfg(test)]
#[path = "../../tests/unit/file_identity.rs"]
mod tests;
