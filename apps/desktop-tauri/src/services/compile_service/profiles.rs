// SPDX-License-Identifier: Apache-2.0
//! Trusted Managed/System/Custom TeX compile profiles, executable and directory
//! verification, and isolated process environment construction.

use std::{
    collections::{BTreeMap, HashSet},
    env,
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use crate::shared::relative_path::RelativePath;

use super::{
    CompileServiceError, DEFAULT_COLD_TIMEOUT, DEFAULT_WARM_TIMEOUT, MAX_PROFILE_TIMEOUT,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SystemTool {
    LatexMk,
    PdfLatex,
    XeLatex,
    LuaLatex,
    TrustedCustom,
}

/// Host-created argv template. Output substitutions occupy one argv element;
/// no shell parser is involved.
#[derive(Clone, Debug)]
pub(crate) enum SystemArgument {
    Literal(OsString),
    EntryPath,
    OutputDirectory,
    OutputDirectoryWithPrefix(OsString),
}

#[derive(Clone, Debug)]
pub(crate) struct ManagedProfile {
    #[cfg(test)]
    pub(super) test_bundle: Option<PathBuf>,
    pub(super) executable: PathBuf,
    pub(super) cache_directory: PathBuf,
    pub(super) search_paths: Vec<PathBuf>,
    pub(super) environment: Vec<(OsString, OsString)>,
    pub(super) cold_timeout: Duration,
    pub(super) warm_timeout: Duration,
}

impl ManagedProfile {
    pub(crate) fn new(
        executable: PathBuf,
        cache_directory: PathBuf,
        search_paths: Vec<PathBuf>,
        environment: Vec<(OsString, OsString)>,
    ) -> Result<Self, CompileServiceError> {
        if !executable.is_absolute() {
            return Err(CompileServiceError::InvalidConfiguration(
                "managed executable must be absolute",
            ));
        }
        if !cache_directory.is_absolute() {
            return Err(CompileServiceError::InvalidConfiguration(
                "managed cache directory must be absolute",
            ));
        }
        if search_paths.iter().any(|path| !path.is_absolute()) {
            return Err(CompileServiceError::InvalidConfiguration(
                "managed search paths must be absolute",
            ));
        }
        validate_timeout(DEFAULT_COLD_TIMEOUT)?;
        validate_timeout(DEFAULT_WARM_TIMEOUT)?;
        Ok(Self {
            #[cfg(test)]
            test_bundle: None,
            executable,
            cache_directory,
            search_paths,
            environment: validate_profile_environment(environment)?,
            cold_timeout: DEFAULT_COLD_TIMEOUT,
            warm_timeout: DEFAULT_WARM_TIMEOUT,
        })
    }

    #[cfg(test)]
    pub(super) fn with_test_bundle(mut self, bundle: PathBuf) -> Self {
        self.test_bundle = Some(bundle);
        self
    }

    #[cfg(test)]
    pub(super) fn with_timeouts(
        mut self,
        cold_timeout: Duration,
        warm_timeout: Duration,
    ) -> Result<Self, CompileServiceError> {
        validate_timeout(cold_timeout)?;
        validate_timeout(warm_timeout)?;
        self.cold_timeout = cold_timeout;
        self.warm_timeout = warm_timeout;
        Ok(self)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct SystemProfile {
    pub(super) executable: PathBuf,
    pub(super) arguments: Vec<SystemArgument>,
    pub(super) search_paths: Vec<PathBuf>,
    pub(super) environment: Vec<(OsString, OsString)>,
    pub(super) timeout: Duration,
    pub(super) output_stem: Option<OsString>,
    pub(super) synctex: bool,
}

impl SystemProfile {
    pub(crate) fn new(
        tool: SystemTool,
        executable: PathBuf,
        arguments: Vec<SystemArgument>,
        search_paths: Vec<PathBuf>,
        environment: Vec<(OsString, OsString)>,
        timeout: Duration,
        output_stem: Option<OsString>,
    ) -> Result<Self, CompileServiceError> {
        if !executable.is_absolute() {
            return Err(CompileServiceError::InvalidConfiguration(
                "system executable must be absolute",
            ));
        }
        if !arguments
            .iter()
            .any(|arg| matches!(arg, SystemArgument::EntryPath))
        {
            return Err(CompileServiceError::InvalidConfiguration(
                "system profile must contain an entry-path argv element",
            ));
        }
        if !arguments.iter().any(|arg| {
            matches!(
                arg,
                SystemArgument::OutputDirectory | SystemArgument::OutputDirectoryWithPrefix(_)
            )
        }) {
            return Err(CompileServiceError::InvalidConfiguration(
                "system profile must direct output to the private run directory",
            ));
        }
        for arg in &arguments {
            if let SystemArgument::Literal(value)
            | SystemArgument::OutputDirectoryWithPrefix(value) = arg
            {
                if value.to_string_lossy().contains('\0') {
                    return Err(CompileServiceError::InvalidConfiguration(
                        "system argv contains an embedded NUL",
                    ));
                }
            }
        }
        if search_paths.iter().any(|path| !path.is_absolute()) {
            return Err(CompileServiceError::InvalidConfiguration(
                "system search paths must be absolute",
            ));
        }
        if let Some(stem) = &output_stem {
            validate_output_stem(stem)?;
        }
        validate_timeout(timeout)?;
        let has_disabled_synctex = arguments.iter().any(|argument| match argument {
            SystemArgument::Literal(value) => {
                let value = value.to_string_lossy();
                value.eq_ignore_ascii_case("-synctex=0")
                    || value.eq_ignore_ascii_case("--synctex=0")
                    || value.eq_ignore_ascii_case("-no-synctex")
            }
            _ => false,
        });
        let has_enabled_synctex = arguments.iter().any(|argument| match argument {
            SystemArgument::Literal(value) => {
                let value = value.to_string_lossy();
                value.eq_ignore_ascii_case("-synctex=1")
                    || value.eq_ignore_ascii_case("--synctex=1")
                    || value.eq_ignore_ascii_case("--synctex")
            }
            _ => false,
        });
        let synctex = !matches!(tool, SystemTool::TrustedCustom) || has_enabled_synctex;
        if synctex && has_disabled_synctex {
            return Err(CompileServiceError::InvalidConfiguration(
                "system profile disables required SyncTeX output",
            ));
        }
        Ok(Self {
            executable,
            arguments,
            search_paths,
            environment: validate_profile_environment(environment)?,
            timeout,
            output_stem,
            synctex,
        })
    }
}

#[derive(Clone, Debug)]
pub(crate) struct TrustedCompileConfig {
    pub(super) temporary_root: PathBuf,
    pub(super) managed: Option<ManagedProfile>,
    pub(super) system: Option<SystemProfile>,
}

impl TrustedCompileConfig {
    pub(crate) fn new(
        temporary_root: PathBuf,
        managed: Option<ManagedProfile>,
        system: Option<SystemProfile>,
    ) -> Result<Self, CompileServiceError> {
        let temporary_root = prepare_trusted_directory(&temporary_root)
            .map_err(|_| CompileServiceError::InvalidConfiguration("temporary root"))?;
        Ok(Self {
            temporary_root,
            managed,
            system,
        })
    }
}

#[derive(Clone, Debug)]
pub(super) enum ResolvedProfile {
    Managed {
        #[cfg(test)]
        test_bundle: Option<PathBuf>,
        executable: PathBuf,
        cache_directory: PathBuf,
        search_paths: Vec<PathBuf>,
        environment: Vec<(OsString, OsString)>,
        cold_timeout: Duration,
        warm_timeout: Duration,
    },
    System {
        executable: PathBuf,
        arguments: Vec<SystemArgument>,
        search_paths: Vec<PathBuf>,
        environment: Vec<(OsString, OsString)>,
        timeout: Duration,
        output_stem: Option<OsString>,
        synctex: bool,
    },
}

pub(super) fn windows_command_tokens(command: &str) -> Result<Vec<String>, CompileServiceError> {
    if command.is_empty()
        || command.encode_utf16().count() > 4096
        || command
            .chars()
            .any(|character| character == '\0' || character == '\n' || character == '\r')
    {
        return Err(CompileServiceError::InvalidConfiguration(
            "custom command text",
        ));
    }
    let characters = command.chars().collect::<Vec<_>>();
    let mut index = 0usize;
    let mut output = Vec::new();
    while index < characters.len() {
        while index < characters.len() && characters[index].is_whitespace() {
            index += 1;
        }
        if index == characters.len() {
            break;
        }
        let mut token = String::new();
        let mut quoted = false;
        while index < characters.len() {
            if characters[index].is_whitespace() && !quoted {
                break;
            }
            if characters[index] == '\\' {
                let start = index;
                while index < characters.len() && characters[index] == '\\' {
                    index += 1;
                }
                let count = index - start;
                if index < characters.len() && characters[index] == '"' {
                    token.extend(std::iter::repeat_n('\\', count / 2));
                    if count % 2 == 1 {
                        token.push('"');
                        index += 1;
                    } else {
                        quoted = !quoted;
                        index += 1;
                    }
                } else {
                    token.extend(std::iter::repeat_n('\\', count));
                }
                continue;
            }
            if characters[index] == '"' {
                quoted = !quoted;
                index += 1;
                continue;
            }
            token.push(characters[index]);
            index += 1;
        }
        if quoted || token.is_empty() {
            return Err(CompileServiceError::InvalidConfiguration(
                "custom command quoting",
            ));
        }
        output.push(token);
    }
    if output.len() < 3 {
        return Err(CompileServiceError::InvalidConfiguration(
            "custom command requires executable, output, and {main}",
        ));
    }
    Ok(output)
}

pub(super) fn is_native_custom_executable(path: &Path) -> bool {
    path.extension()
        .and_then(std::ffi::OsStr::to_str)
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("exe") || extension.eq_ignore_ascii_case("com")
        })
}

pub(super) fn resolve_custom_executable(
    executable_text: &str,
    path_value: Option<&std::ffi::OsStr>,
) -> Result<PathBuf, CompileServiceError> {
    let executable_path = PathBuf::from(executable_text);
    if executable_path.is_absolute() {
        if !is_native_custom_executable(&executable_path) {
            return Err(CompileServiceError::InvalidConfiguration(
                "custom executable must be a native Windows executable",
            ));
        }
        return resolve_trusted_executable(&executable_path).map_err(|_| {
            CompileServiceError::InvalidConfiguration("custom executable is missing or unsafe")
        });
    }

    if executable_text.is_empty()
        || executable_text == "."
        || executable_text == ".."
        || executable_text.contains('/')
        || executable_text.contains('\\')
        || executable_text.contains(':')
        || executable_text.ends_with('.')
        || executable_text.ends_with(' ')
        || executable_text.chars().any(|character| {
            character.is_control() || matches!(character, '<' | '>' | '"' | '|' | '?' | '*')
        })
    {
        return Err(CompileServiceError::InvalidConfiguration(
            "custom executable must be absolute or a PATH name",
        ));
    }

    let extension = Path::new(executable_text)
        .extension()
        .and_then(std::ffi::OsStr::to_str);
    let executable_name = match extension {
        None => format!("{executable_text}.exe"),
        Some(extension)
            if extension.eq_ignore_ascii_case("exe") || extension.eq_ignore_ascii_case("com") =>
        {
            executable_text.to_owned()
        }
        Some(_) => {
            return Err(CompileServiceError::InvalidConfiguration(
                "custom executable must be a native Windows executable",
            ));
        }
    };

    let path_value = path_value.ok_or(CompileServiceError::InvalidConfiguration(
        "trusted PATH is unavailable",
    ))?;
    for directory in env::split_paths(path_value).filter(|directory| directory.is_absolute()) {
        let candidate = directory.join(&executable_name);
        if let Ok(executable) = resolve_trusted_executable(&candidate) {
            return Ok(executable);
        }
    }
    Err(CompileServiceError::InvalidConfiguration(
        "custom executable is missing or unsafe",
    ))
}

pub(super) fn custom_system_profile(command: &str) -> Result<SystemProfile, CompileServiceError> {
    let tokens = windows_command_tokens(command)?;
    let executable_text = &tokens[0];
    let path_value = env::var_os("PATH");
    let executable = resolve_custom_executable(executable_text, path_value.as_deref())?;

    let mut arguments = Vec::with_capacity(tokens.len());
    let mut has_entry = false;
    let mut has_output = false;
    for token in tokens.iter().skip(1) {
        if token == "{main}" {
            has_entry = true;
            arguments.push(SystemArgument::EntryPath);
        } else if token == "{out}" || token == "{output}" {
            has_output = true;
            arguments.push(SystemArgument::OutputDirectory);
        } else if token.ends_with("{out}") && token.len() > "{out}".len() {
            let prefix = &token[..token.len() - "{out}".len()];
            if prefix.contains('{') || prefix.contains('}') {
                return Err(CompileServiceError::InvalidConfiguration(
                    "custom command placeholder",
                ));
            }
            has_output = true;
            arguments.push(SystemArgument::OutputDirectoryWithPrefix(OsString::from(
                prefix,
            )));
        } else {
            if token.contains('{') || token.contains('}') || token.chars().any(char::is_control) {
                return Err(CompileServiceError::InvalidConfiguration(
                    "custom command placeholder or control character",
                ));
            }
            arguments.push(SystemArgument::Literal(OsString::from(token)));
        }
    }
    if !has_entry || !has_output {
        return Err(CompileServiceError::InvalidConfiguration(
            "custom command must include {main} and {out}",
        ));
    }
    let search_paths = executable
        .parent()
        .map(|parent| vec![parent.to_path_buf()])
        .unwrap_or_default();
    SystemProfile::new(
        SystemTool::TrustedCustom,
        executable,
        arguments,
        search_paths,
        Vec::new(),
        Duration::from_secs(300),
        None,
    )
}

pub(crate) fn validate_custom_command_template(command: &str) -> Result<(), CompileServiceError> {
    custom_system_profile(command).map(|_| ())
}

pub(super) fn entry_stem(entry: &RelativePath) -> Result<String, CompileServiceError> {
    let leaf = entry
        .as_str()
        .rsplit('/')
        .next()
        .ok_or(CompileServiceError::InvalidRequest(
            "entryPath has no filename",
        ))?;
    let stem = Path::new(leaf)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or(CompileServiceError::InvalidRequest(
            "entryPath has no safe output stem",
        ))?;
    validate_output_stem(&OsString::from(stem))?;
    Ok(stem.to_owned())
}

pub(super) fn validate_output_stem(stem: &OsString) -> Result<(), CompileServiceError> {
    let Some(stem) = stem.to_str() else {
        return Err(CompileServiceError::InvalidConfiguration(
            "PDF output stem must be UTF-8",
        ));
    };
    if stem.is_empty()
        || stem == "."
        || stem == ".."
        || stem.contains('/')
        || stem.contains('\\')
        || stem.contains(':')
        || stem
            .chars()
            .any(|character| character <= '\u{1f}' || character == '\u{7f}')
    {
        return Err(CompileServiceError::InvalidConfiguration(
            "PDF output stem is not a filename",
        ));
    }
    Ok(())
}

pub(super) fn validate_timeout(timeout: Duration) -> Result<(), CompileServiceError> {
    if timeout.is_zero() || timeout > MAX_PROFILE_TIMEOUT {
        return Err(CompileServiceError::InvalidConfiguration(
            "profile timeout is outside the bounded range",
        ));
    }
    Ok(())
}

pub(super) fn validate_profile_environment(
    environment: Vec<(OsString, OsString)>,
) -> Result<Vec<(OsString, OsString)>, CompileServiceError> {
    let mut seen = HashSet::new();
    for (key, value) in &environment {
        let Some(key_text) = key.to_str() else {
            return Err(CompileServiceError::InvalidConfiguration(
                "profile environment key must be ASCII",
            ));
        };
        if key_text.is_empty()
            || key_text.len() > 128
            || !key_text
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            || value.to_string_lossy().contains('\0')
        {
            return Err(CompileServiceError::InvalidConfiguration(
                "profile environment entry is invalid",
            ));
        }
        let folded = key_text.to_ascii_uppercase();
        if matches!(
            folded.as_str(),
            "PATH"
                | "TEMP"
                | "TMP"
                | "TECTONIC_CACHE_DIR"
                | "SYSTEMROOT"
                | "WINDIR"
                | "FONTCONFIG_FILE"
                | "FONTCONFIG_PATH"
        ) {
            return Err(CompileServiceError::InvalidConfiguration(
                "profile environment overrides a host-controlled key",
            ));
        }
        if !seen.insert(folded) {
            return Err(CompileServiceError::InvalidConfiguration(
                "profile environment has duplicate keys",
            ));
        }
    }
    Ok(environment)
}

pub(crate) fn resolve_trusted_executable(path: &Path) -> Result<PathBuf, io::Error> {
    if !path.is_absolute() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not absolute"));
    }
    crate::state::recent::check_path_not_symlink_or_reparse(path, None)
        .map_err(|_| io::Error::new(io::ErrorKind::PermissionDenied, "link rejected"))?;
    let canonical = fs::canonicalize(path)?;
    crate::state::recent::check_path_not_symlink_or_reparse(&canonical, None)
        .map_err(|_| io::Error::new(io::ErrorKind::PermissionDenied, "link rejected"))?;
    let metadata = fs::symlink_metadata(&canonical)?;
    if crate::platform::file_identity::is_symlink_or_reparse(&metadata) || !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "executable is not a regular file",
        ));
    }
    Ok(canonical)
}

pub(super) fn resolve_search_paths(paths: &[PathBuf]) -> Result<Vec<PathBuf>, io::Error> {
    paths
        .iter()
        .map(|path| {
            if !path.is_absolute() {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, "not absolute"));
            }
            crate::state::recent::check_path_not_symlink_or_reparse(path, None)
                .map_err(|_| io::Error::new(io::ErrorKind::PermissionDenied, "link rejected"))?;
            let canonical = fs::canonicalize(path)?;
            let metadata = fs::symlink_metadata(&canonical)?;
            if crate::platform::file_identity::is_symlink_or_reparse(&metadata)
                || !metadata.is_dir()
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "search path is not a directory",
                ));
            }
            Ok(canonical)
        })
        .collect()
}

pub(super) fn prepare_trusted_directory(path: &Path) -> Result<PathBuf, io::Error> {
    if !path.is_absolute() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not absolute"));
    }
    fs::create_dir_all(path)?;
    crate::state::recent::check_path_not_symlink_or_reparse(path, None)
        .map_err(|_| io::Error::new(io::ErrorKind::PermissionDenied, "link rejected"))?;
    let canonical = fs::canonicalize(path)?;
    let metadata = fs::symlink_metadata(&canonical)?;
    if crate::platform::file_identity::is_symlink_or_reparse(&metadata) || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a trusted directory",
        ));
    }
    Ok(canonical)
}

pub(super) fn has_cached_latex_format(cache: &Path) -> Result<bool, io::Error> {
    let formats = cache.join("formats");
    let metadata = match fs::symlink_metadata(&formats) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if crate::platform::file_identity::is_symlink_or_reparse(&metadata) || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "format cache directory is unsafe",
        ));
    }
    for entry in fs::read_dir(formats)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let lower = name.to_ascii_lowercase();
        let Some((digest, suffix)) = lower.split_once("-latex-33.fmt") else {
            continue;
        };
        if !suffix.is_empty()
            || digest.len() != 64
            || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            continue;
        }
        let file_metadata = fs::symlink_metadata(entry.path())?;
        if !crate::platform::file_identity::is_symlink_or_reparse(&file_metadata)
            && file_metadata.is_file()
            && file_metadata.len() > 0
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) fn build_process_environment(
    profile_environment: &[(OsString, OsString)],
    search_paths: &[PathBuf],
    executable: Option<&Path>,
    temporary_directory: &Path,
    tectonic_cache: Option<&Path>,
) -> Result<Vec<(OsString, OsString)>, CompileServiceError> {
    let mut values: BTreeMap<String, (OsString, OsString)> = BTreeMap::new();
    let mut put = |key: &str, value: OsString| {
        values.insert(key.to_ascii_uppercase(), (OsString::from(key), value));
    };
    for key in [
        "SystemRoot",
        "SystemDrive",
        "windir",
        "ComSpec",
        "PATHEXT",
        "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE",
    ] {
        if let Some(value) = env::var_os(key) {
            put(key, value);
        }
    }
    let system_root = env::var_os("SystemRoot").ok_or(
        CompileServiceError::InvalidConfiguration("Windows SystemRoot is unavailable"),
    )?;
    let mut path_entries = Vec::new();
    if let Some(executable) = executable {
        if let Some(parent) = executable.parent() {
            path_entries.push(parent.to_path_buf());
        }
    }
    path_entries.extend(search_paths.iter().cloned());
    path_entries.push(PathBuf::from(&system_root).join("System32"));
    let path = env::join_paths(path_entries)
        .map_err(|_| CompileServiceError::InvalidConfiguration("trusted PATH is invalid"))?;
    put("PATH", path);
    put("TEMP", temporary_directory.as_os_str().to_owned());
    put("TMP", temporary_directory.as_os_str().to_owned());
    if let Some(cache) = tectonic_cache {
        put("TECTONIC_CACHE_DIR", cache.as_os_str().to_owned());
        // The bundled Windows engine has no installed Fontconfig configuration.
        // Keep its font discovery host-owned and isolated from workspace files.
        let xml_path = |path: &Path| {
            path.to_string_lossy()
                .replace('\\', "/")
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
        };
        let config_path = temporary_directory.join("fontconfig.xml");
        let config = format!(
            "<?xml version=\"1.0\"?><fontconfig><dir>{}</dir><cachedir>{}</cachedir></fontconfig>",
            xml_path(&PathBuf::from(&system_root).join("Fonts")),
            xml_path(&cache.join("fontconfig"))
        );
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&config_path)
            .map_err(|_| {
                CompileServiceError::InvalidConfiguration(
                    "private font configuration could not be created",
                )
            })?;
        file.write_all(config.as_bytes()).map_err(|_| {
            CompileServiceError::InvalidConfiguration(
                "private font configuration could not be written",
            )
        })?;
        put("FONTCONFIG_FILE", config_path.into_os_string());
    }
    for (key, value) in profile_environment {
        let key = key
            .to_str()
            .ok_or(CompileServiceError::InvalidConfiguration(
                "profile environment key must be ASCII",
            ))?;
        put(key, value.clone());
    }
    Ok(values.into_values().collect())
}
