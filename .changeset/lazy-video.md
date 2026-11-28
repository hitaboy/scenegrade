---
'@scenegrade/core': patch
'@scenegrade/element': patch
---

Video support (Mediabunny) is loaded on demand when a video is opened: the `<scenegrade-player>` bundle drops from ~200 KB to ~100 KB gzipped for EXR and image use.
