// SPDX-License-Identifier: Apache-2.0
//! Platform file identity and no-follow link checking primitives.

use std::{
    fs::{self, File, OpenOptions},
    io,
    path::Path,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct FileIdentity {
    pub volume_serial: u64,
    pub file_id: u128,
}

#[cfg(windows)]
pub(crate) const FILE_ID_INFO_CLASS: i32 = 18;

#[cfg(windows)]
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub(crate) struct Win32FileIdInfo {
    pub(crate) volume_serial_number: u64,
    pub(crate) file_id: [u8; 16],
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
    pub(crate) fn GetFileInformationByHandleEx(
        file: *mut std::ffi::c_void,
        info_class: i32,
        information: *mut std::ffi::c_void,
        buffer_size: u32,
    ) -> i32;
}

#[cfg(windows)]
pub(crate) fn query_raw_handle_metadata(
    raw: *mut std::ffi::c_void,
) -> io::Result<(FileIdentity, u32, u64)> {
    use std::mem::zeroed;

    let mut information: ByHandleFileInformation = unsafe { zeroed() };
    if unsafe { GetFileInformationByHandle(raw, &mut information) } == 0 {
        return Err(io::Error::last_os_error());
    }

    let mut id_information: Win32FileIdInfo = unsafe { zeroed() };
    if unsafe {
        GetFileInformationByHandleEx(
            raw,
            FILE_ID_INFO_CLASS,
            (&mut id_information as *mut Win32FileIdInfo).cast(),
            std::mem::size_of::<Win32FileIdInfo>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }

    let identity = FileIdentity {
        volume_serial: id_information.volume_serial_number,
        file_id: u128::from_le_bytes(id_information.file_id),
    };
    let size =
        (u64::from(information._file_size_high) << 32) | u64::from(information._file_size_low);
    Ok((identity, information.file_attributes, size))
}

#[cfg(windows)]
pub(crate) fn query_raw_handle_identity(
    raw: *mut std::ffi::c_void,
) -> io::Result<(FileIdentity, u32)> {
    let (identity, attributes, _) = query_raw_handle_metadata(raw)?;
    Ok((identity, attributes))
}

#[cfg(windows)]
pub(crate) fn file_identity(file: &File) -> io::Result<FileIdentity> {
    use std::os::windows::io::AsRawHandle;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    let (identity, attributes, _) = query_raw_handle_metadata(file.as_raw_handle())?;
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "reparse-point identity is not accepted",
        ));
    }
    Ok(identity)
}

#[cfg(unix)]
pub(crate) fn file_identity(file: &File) -> io::Result<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata()?;
    Ok(FileIdentity {
        volume_serial: meta.dev(),
        file_id: meta.ino() as u128,
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
