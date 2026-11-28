---
'@scenegrade/core': patch
'@scenegrade/svelte': patch
---

A wheel or curve drag is one undo step however slow it is (`player.beginGradeEdit()` on pointer down … `commitGradeEdit()` on pointer up); before, pauses longer than 800 ms split it.
