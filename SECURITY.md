# Security policy

The player parses untrusted files (EXR, MOV/MP4, images) in the browser. Decoders run as
WebAssembly inside Web Workers, but memory-safety bugs in a decoder are still security bugs.

Please report vulnerabilities **privately** via GitHub's "Report a vulnerability" (Security tab),
not in public issues. Include the file or the steps to reproduce. We aim to answer within 7 days.

Supported versions: the latest minor release.
