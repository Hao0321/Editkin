use std::collections::{HashSet, VecDeque};
use std::path::{Component, Path, PathBuf};

const MAX_GRANTS: usize = 10_000;

/// Paths the user selected (open/save dialogs, drag and drop) or loaded (assets of
/// a project they opened). A webview request that names any other path is
/// refused, so a compromised renderer cannot make the main process read or
/// write arbitrary files. Matching is on the lexically normalized path, so a
/// grant made before the file exists (a Save As target) still matches.
pub struct PathGrants {
    case_insensitive: bool,
    order: VecDeque<String>,
    keys: HashSet<String>,
}

impl Default for PathGrants {
    fn default() -> Self {
        Self::new(cfg!(windows))
    }
}

impl PathGrants {
    pub fn new(case_insensitive: bool) -> Self {
        Self {
            case_insensitive,
            order: VecDeque::new(),
            keys: HashSet::new(),
        }
    }

    pub fn grant(&mut self, path: &Path) {
        let Some(key) = normalized_key(path, self.case_insensitive) else {
            return;
        };
        if !self.keys.insert(key.clone()) {
            self.order.retain(|existing| existing != &key);
        }
        self.order.push_back(key);
        while self.order.len() > MAX_GRANTS {
            if let Some(oldest) = self.order.pop_front() {
                self.keys.remove(&oldest);
            }
        }
    }

    pub fn contains(&self, path: &Path) -> bool {
        normalized_key(path, self.case_insensitive).is_some_and(|key| self.keys.contains(&key))
    }
}

/// `None` for relative paths: a grant always names one absolute location.
fn normalized_key(path: &Path, case_insensitive: bool) -> Option<String> {
    if !path.is_absolute() {
        return None;
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    let key = normalized.to_string_lossy().into_owned();
    Some(if case_insensitive {
        key.to_lowercase()
    } else {
        key
    })
}

/// Project files always carry a compound `.editkin.json` / `.haoedit.json` extension.
pub fn is_project_file_path(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    name.ends_with(".editkin.json") || name.ends_with(".haoedit.json")
}

/// True when `path` is strictly inside `root` after lexical normalization.
pub fn is_within(root: &Path, path: &Path) -> bool {
    let (Some(root), Some(path)) = (normalized_key(root, false), normalized_key(path, false))
    else {
        return false;
    };
    path.len() > root.len()
        && path.starts_with(&root)
        && path[root.len()..].starts_with(std::path::MAIN_SEPARATOR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_granted_absolute_paths_match() {
        let mut grants = PathGrants::new(false);
        grants.grant(Path::new("/media/clip.mp4"));
        assert!(grants.contains(Path::new("/media/clip.mp4")));
        assert!(grants.contains(Path::new("/media/./clip.mp4")));
        assert!(!grants.contains(Path::new("/media/other.mp4")));
        assert!(!grants.contains(Path::new("/media/../etc/passwd")));
        assert!(!grants.contains(Path::new("clip.mp4")));
        grants.grant(Path::new("relative.mp4"));
        assert!(!grants.contains(Path::new("relative.mp4")));
    }

    #[test]
    fn case_sensitivity_follows_the_platform_flag() {
        let mut windows = PathGrants::new(true);
        windows.grant(Path::new("/Media/Clip.MP4"));
        assert!(windows.contains(Path::new("/media/clip.mp4")));
        let mut posix = PathGrants::new(false);
        posix.grant(Path::new("/Media/Clip.mp4"));
        assert!(!posix.contains(Path::new("/media/clip.mp4")));
    }

    #[test]
    fn grants_stay_bounded_and_evict_the_oldest() {
        let mut grants = PathGrants::new(false);
        for index in 0..=MAX_GRANTS {
            grants.grant(Path::new(&format!("/m/{index}.mp4")));
        }
        assert!(!grants.contains(Path::new("/m/0.mp4")));
        assert!(grants.contains(Path::new(&format!("/m/{MAX_GRANTS}.mp4"))));
    }

    #[test]
    fn project_files_need_the_compound_extension() {
        assert!(is_project_file_path(Path::new("/p/Demo.editkin.json")));
        assert!(is_project_file_path(Path::new("/p/Demo.HAOEDIT.JSON")));
        for path in ["/p/.bashrc", "/p/notes.json", "/p/Demo.editkin.json.lock", "/p/a.exe", "/p/"] {
            assert!(!is_project_file_path(Path::new(path)), "{path}");
        }
    }

    #[test]
    fn within_is_strict_and_lexical() {
        assert!(is_within(Path::new("/cache"), Path::new("/cache/a/proxy.mp4")));
        assert!(!is_within(Path::new("/cache"), Path::new("/cache")));
        assert!(!is_within(Path::new("/cache"), Path::new("/cache2/x")));
        assert!(!is_within(Path::new("/cache"), Path::new("/cache/../etc/passwd")));
    }
}
