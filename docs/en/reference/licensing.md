# Licensing

[日本語](../../ja/reference/licensing.md)

| Part | License | Reason |
|---|---|---|
| `prep/` (preprocessing) | GPL-3.0-or-later | Loads Infomap (GPL-3.0-or-later) in the same process |
| `prep/amipa_prep/cs_ops.py` and `prep/amipa_prep/zstd_seek.py` | MIT | Copied into the viewer so that it reads the same formats; unrelated to Infomap (below) |
| `viewer/` (viewer) | MIT | No copyleft dependencies; easy to embed in other software |
| Documentation | CC BY 4.0 | |

[LICENSE](../../../LICENSE) at the repository root is GPL-3.0 (the terms for the whole), and [viewer/LICENSE](../../../viewer/LICENSE) is MIT. Bundled components and their sources are listed in [NOTICE](../../../NOTICE).

## Two files shared by preprocessing and viewer

The read container (seekable zstd) and `cs:Z` slicing must match between the writer (preprocessing) and the reader (viewer), so the implementation lives in one place and is shared. It sits on the preprocessing side and is copied into the viewer when the viewer image is built.

These two files do not use Infomap, so there is no reason for GPL; they are provided under MIT (each starts with `SPDX-License-Identifier: MIT`). As a result, all AMIPA code in the distributed viewer image is MIT.

## Redistributing the container images

The images contain software besides AMIPA.

| Image | AMIPA code | Other bundled software |
|---|---|---|
| `amipa-prep` | GPL-3.0-or-later | Infomap (GPL-3.0-or-later), BubbleFinder (GPL-3.0), Python packages, Debian system packages |
| `amipa-viewer` | MIT | Node.js, Debian system packages |

Both images are based on Debian and therefore include GPL/LGPL system packages. To redistribute them unchanged, it is enough to:

1. Distribute `NOTICE` with them (it is also inside the image at `/opt/amipa/NOTICE`)
2. State how to obtain the corresponding source of the GPL components. The bundled versions are unmodified public releases, so the sources and versions listed in `NOTICE` suffice

If you distribute a modified Infomap, you must provide the modified source.

The full license texts are inside the images too (`/opt/amipa/LICENSE`: GPL-3.0 for prep, MIT for viewer). `amipa licenses` prints both `NOTICE` and the full text, so someone who receives only the image can check the terms.

## Embedding AMIPA

- Viewer only (embedding DB display in your software) → MIT, free to use. The two shared files are MIT as well, so the whole viewer can be taken as is
- Including preprocessing → follow GPL-3.0-or-later (derivatives are published under GPL)

To make preprocessing permissively licensed, Infomap could be called as a separate process (it currently uses the Python API in the same process). Open an issue if you need this.
