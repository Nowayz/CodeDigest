<p align="center">
  <img src="https://raw.githubusercontent.com/Nowayz/CodeDigest/refs/heads/resources/codedigest_logo.png" alt="logo"/>
</p>
CodeDigest is a lean Node.js command-line tool that supports exporting and importing source-code digests (all text-files combined as one). Exporting allows uploading to an LLM, and importing allows an LLM to suggest changes that can be directly imported by the tool.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Installation](#installation)
3. [Usage](#usage)
4. [Operating Modes](#operating-modes)
5. [Options](#options)
6. [Ignore & Include Patterns](#ignore--include-patterns)
7. [Digest Format](#digest-format)
8. [How It Works](#how-it-works)
9. [Nuances & Limits](#nuances--limits)
10. [License](#license)

### Quick Start

```bash
npx codedigest --path ./myproject --output consolidated.txt
```

Once run, **`consolidated.txt`** will include:

1. A **directory tree** of `myproject` (excluding specified patterns).
2. **All text-based file contents** (subject to size limits).
3. A **summary** (stats, ignore patterns, errors, etc.) displayed in the terminal.

#### Example Output
```
Code Digest for Directory: /path/to/myproject
Generated: 2025-04-11T15:30:45.123Z

Directory Structure (42 included files shown)
==================================================
myproject/
├── package.json
├── index.js
├── src/
│   ├── app.js
│   └── utils.js
└── README.md

Included File Contents (235 KB)
==================================================

### CODEDIGEST_FILE: package.json ###
{
  "name": "myproject",
  "version": "1.0.0",
  ...
}
### CODEDIGEST_END ###

### CODEDIGEST_FILE: index.js ###
console.log("Hello World!");
### CODEDIGEST_END ###

...etc...
```

This file can be fed directly to your LLM. For example, if you have an API or local setup where you can provide a text context to a language model, just drop the contents of the digest file into the prompt or your specialized ingestion pipeline.

### Installation
1. Ensure you have [Node.js](https://nodejs.org) and [npm](https://www.npmjs.com/) installed. npm is typically bundled with Node.js.
2. Run the script using `npx`:
   ```bash
   npx codedigest
   ```
   `npx` will automatically download and run `codedigest` without needing a global installation.

### Usage
```bash
npx codedigest --help
```
```
codedigest.mjs - Generate or import a digest of a directory's text file contents.

 Modes 

  Generate Mode (Default): Creates a digest file from a directory.
  Import Mode: Creates/updates files in a directory based on a digest file.
               Uses checksum comparison between digest content and existing file content.

 Generate Mode Options 

  --path <dir>, -p <dir>           Directory to process (default: current directory ".")
  --output <file>, -o <file>       Output digest file path (default: "digest.txt")
  --ignore <file>, -g <file>       Load ignore patterns from a .gitignore-style file
  --include <file>, -n <file>      Load include patterns from a .gitignore-style file
                                   (If includes are used, only matching files are added)
  --ignore-pattern <ptn>, -i <ptn> Add a single ignore pattern (can use multiple times)
  --include-pattern <ptn>, -I <ptn> Add a single include pattern (can use multiple times)
  --max-size <bytes>, -s <bytes>   Max individual file size (default: 10 MB)
                                   Supports suffixes KB, MB, GB (e.g., 10MB)
  --max-total-size <bytes>, -t <bytes> Max total size of all included files (default: 500 MB)
                                   Supports suffixes KB, MB, GB (e.g., 500MB)
  --max-depth <num>, -d <num>      Max directory recursion depth (default: 20)
  --skip-default-ignore, -k        Do not use built-in default ignore patterns
                                   (like node_modules, .git, build, etc.)
  --quiet, -q                      Suppress file add/skip messages (shows summary)
  --ultra-quiet, -uq               Suppress all output except fatal errors

 Import Mode Options 

  --import <file>, -im <file>      REQUIRED: Specify the digest file to import.
  --target <dir>, -tg <dir>        Target directory for import (default: current directory ".")
                                   Directory will be created if it doesn't exist.
  --dry-run, -dr                   Show what would happen without making changes.

 General Options 

  --help, -h                       Display this help message and exit.

Examples:
  # Generate digest of src/ folder into my_digest.txt
  node codedigest.mjs -p src/ -o my_digest.txt

  # Generate, excluding *.log files and limiting total size
  node codedigest.mjs -i "*.log" -t 50MB

  # Import digest, creating/updating files in ./output_dir
  node codedigest.mjs --import my_digest.txt --target ./output_dir

  # Dry run import to see changes based on checksum comparison
  node codedigest.mjs --import my_digest.txt -tg ./output_dir --dry-run
```

### Operating Modes

CodeDigest has two operating modes:

#### 1. Generate Mode (Default)
Creates a digest file from a directory containing:
- Tree view of directory structure
- Contents of all text files (respecting size limits and include/ignore patterns)
- A formatted output that's easy to read by both humans and LLMs

#### 2. Import Mode
Recreates files from a digest file:
- Creates or updates files in a target directory based on a digest file
- Uses checksum comparison to determine if files need updating
- Provides safety features like path traversal prevention
- Supports dry-run mode to preview changes before applying them

### Options

| Option                        | Alias | Description                                                | Default                 |
|-------------------------------|-------|------------------------------------------------------------|-------------------------|
| `--path <path>`               | `-p`  | Directory to process.                                     | `.` (current directory) |
| `--output <file>`             | `-o`  | Output file path.                                          | `digest.txt`           |
| `--ignore <file>`             | `-g`  | File containing ignore patterns (gitignore-style).         | —                       |
| `--include <file>`            | `-n`  | File containing include patterns (gitignore-style).        | —                      |
| `--ignore-pattern <pattern>`  | `-i`  | Add an ignore pattern (can be used multiple times).        | —                       |
| `--include-pattern <pattern>` | `-I`  | Add an include pattern (can be used multiple times).       | —                       |
| `--max-size <bytes>`          | `-s`  | Maximum individual file size (in bytes).                   | `10MB`                 |
| `--max-total-size <bytes>`    | `-t`  | Maximum total size (in bytes) before digest stops adding.  | `500MB`                |
| `--max-depth <number>`        | `-d`  | Maximum directory depth.                                   | `20`                   |
| `--quiet`                     | `-q`  | Suppress "Added" and "Skipped" messages.                   | `false`                |
| `--ultra-quiet`               | `-uq` | Suppress all non-error output.                             | `false`                |
| `--skip-default-ignore`       | `-k`  | Skip default ignore patterns; use only user-provided ones. | `false`                 |
| `--import <file>`             | `-im` | Import mode: digest file to import.                        | —                       |
| `--target <dir>`              | `-tg` | Import mode: target directory for import.                  | `.` (current directory) |
| `--dry-run`                   | `-dr` | Import mode: preview changes without modifying files.      | `false`                 |
| `--help`                      | `-h`  | Show help message.                                         | —                       |

### Ignore & Include Patterns

**CodeDigest** uses a combination of **include** and **ignore (exclude)** patterns to precisely control which files are included in the digest. The logic follows these steps:

1.  **Include First**: If any include patterns are provided, CodeDigest **initially selects only the files and directories that match at least one of these include patterns.** If no include patterns are provided, all files and directories are considered for initial selection.

2.  **Exclude Second**: After the initial selection based on include patterns (or all files if no includes), CodeDigest then applies **ignore (exclude) patterns to filter out files and directories from the initially selected set.** This ensures that even if a file matches an include pattern, it can still be excluded if it matches an ignore pattern.

**Default Ignore Patterns:**

**CodeDigest** comes with a comprehensive set of default ignore patterns to exclude common files and directories that are typically unnecessary for analysis or could clutter the digest. Below is the **full list of default exclude patterns**:

**Note:** Always ensure that the default ignore patterns align with your project's specific needs. You can customize them further using the provided command-line options to tailor the digest to your requirements.

```plaintext
*.pyc
*.pyo
*.pyd
__pycache__
.pytest_cache
.coverage
.tox
.nox
.mypy_cache
.ruff_cache
.hypothesis
poetry.lock
Pipfile.lock
node_modules
bower_components
package-lock.json
yarn.lock
.npm
.yarn
.pnpm-store
*.class
*.jar
*.war
*.ear
*.nar
.gradle/
build/
.settings/
.classpath
gradle-app.setting
*.gradle
.project
*.o
*.obj
*.dll
*.dylib
*.exe
*.lib
*.out
*.a
*.pdb
.build/
*.xcodeproj/
*.xcworkspace/
*.pbxuser
*.mode1v3
*.mode2v3
*.perspectivev3
*.xcuserstate
xcuserdata/
.swiftpm/
*.gem
.bundle/
vendor/bundle
Gemfile.lock
.ruby-version
.ruby-gemset
.rvmrc
Cargo.lock
**/*.rs.bk
target/
pkg/
obj/
*.suo
*.user
*.userosscache
*.sln.docstates
packages/
*.nupkg
bin/
.git
.svn
.hg
.gitignore
.gitattributes
.gitmodules
*.svg
*.png
*.jpg
*.jpeg
*.gif
*.ico
*.pdf
*.mov
*.mp4
*.mp3
*.wav
venv
.venv
env
.env
virtualenv
.idea
.vscode
.vs
*.swo
*.swn
.settings
*.sublime-*
*.log
*.bak
*.swp
*.tmp
*.temp
.cache
.sass-cache
.eslintcache
.DS_Store
Thumbs.db
desktop.ini
build
dist
target
out
*.egg-info
*.egg
*.whl
*.so
site-packages
.docusaurus
.next
.nuxt
*.min.js
*.min.css
*.map
.terraform
*.tfstate*
vendor/
```

**Explanation of Common Patterns:**

- **Version Control Directories:** `.git`, `.svn`, `.hg` – These directories contain version control metadata and are typically not needed in a code digest.
- **Dependency Directories:** `node_modules`, `vendor/bundle`, `build`, `dist`, `target`, `pkg`, `bin`, etc. – These directories usually contain dependencies or build artifacts that can be large and are often unnecessary for code analysis.
- **Cache Directories and Files:** `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.cache`, `.sass-cache`, etc. – These are used for caching compiled files or test results and are not relevant for code digestion.
- **Compiled and Binary Files:** `*.pyc`, `*.pyo`, `*.class`, `*.jar`, `*.dll`, `*.exe`, `*.so`, etc. – These are compiled or binary files that are not human-readable and generally not needed.
- **IDE and Editor Configurations:** `.idea`, `.vscode`, `.sublime-*`, `.project`, `.classpath`, etc. – These files are specific to development environments and editors.
- **Log and Temporary Files:** `*.log`, `*.tmp`, `*.temp`, `*.bak`, `*.swp`, etc. – These files are typically temporary or logs that are not useful for code analysis.
- **Media Files:** `*.svg`, `*.png`, `*.jpg`, `*.jpeg`, `*.gif`, `*.ico`, `*.pdf`, `*.mov`, `*.mp4`, `*.mp3`, `*.wav`, etc. – These files are non-textual and usually not necessary for code digestion.
- **Lock Files:** `poetry.lock`, `Pipfile.lock`, `package-lock.json`, `yarn.lock`, `Cargo.lock` – These files lock dependencies but may not be needed in the digest.
- **Others:** Patterns like `**/*.rs.bk`, `*.min.js`, `*.min.css`, etc., exclude backup files and minified code which can be less readable.

**Customizing Ignore Patterns:**

- **Via Command Line:**
  - Add extra patterns using `--ignore-pattern` or `-i`. For example:
    ```bash
    npx codedigest --ignore-pattern '*.log' --ignore-pattern 'temp/'
    ```
- **Via Ignore File:**
  - Create a file (e.g., `.gitignore`) with your custom ignore patterns and specify it using `--ignore <file>` or `-g <file>`. For example:
    ```bash
    npx codedigest --ignore .gitignore
    ```
- **Skipping Default Ignores:**
    - To use only your custom ignore patterns and skip the default patterns, use the `--skip-default-ignore` or `-k` flag.

### Include Patterns
- If **include** patterns are specified, **only** files matching those patterns are considered for processing **before** applying ignore patterns.
- Useful if you want to focus on specific file types like `.js`, `.py`, etc. or particular directories.

For example, to include only JavaScript and Markdown files:
```bash
npx codedigest --path ./myproject \
  --include-pattern '*.js' \
  --include-pattern '*.md'
```

To include files from a specific source directory, and then exclude test files within it:
```bash
npx codedigest --path ./myproject \
  --include-pattern 'src/**' \
  --ignore-pattern 'src/**/*.test.js'
```
This example first includes everything under the `src/` directory and then excludes any files ending with `.test.js` within that `src/` directory.

### Digest Format

CodeDigest uses a structured format for the digest files to ensure reliable parsing and import operations.

#### Format Structure

```
Code Digest for Directory: /path/to/directory
Generated: [timestamp]

Directory Structure ([number] included files shown)
==================================================
[Directory tree display]

Included File Contents ([size])
==================================================

### CODEDIGEST_FILE: [relative/path/to/file] ###
[file content goes here]
### CODEDIGEST_END ###

### CODEDIGEST_FILE: [another/file/path] ###
[another file's content]
### CODEDIGEST_END ###
```

#### Key Components

1. **Header Section**: Contains basic information about when and where the digest was generated
2. **Directory Tree**: Shows the structure of the included files and directories
3. **File Sections**: Each file is enclosed with start and end markers:
   - `### CODEDIGEST_FILE: [path] ###`: Start marker with relative file path
   - `### CODEDIGEST_END ###`: End marker signifying the end of a file's content

#### Important Changes

- **Strict End Markers**: Every file section must end with a `CODEDIGEST_END` marker. During import, any section without an end marker is considered malformed and won't be processed.
- **Checksum Handling**: Checksums are no longer stored in the digest file. Instead, they're calculated dynamically during import to compare digest content with existing file content.

### How CodeDigest Works

#### Generate Mode

1. **Directory Traversal**
   Recursively scans folders up to a user-defined depth, respecting symlinks (and avoiding loops by tracking seen paths and symlinks).
2. **Include Checking**
   If include patterns are provided, checks if the current path matches any of the include patterns. Only included paths proceed to the next step.
3. **Ignore Checking**
   Checks if the path matches any ignore patterns. If it does, the path is skipped.
4. **File Reading**
   - Only reads **text-based** files (determined by file extension and null byte check).
   - Large text files are read in chunks to avoid memory issues.
   - Skips files larger than `--max-size`.
   - Stops adding new files once `--max-total-size` is reached (but still traverses the structure).
5. **Directory Tree Generation**
   - Generates a **directory tree** in text form, omitting any files or directories that were excluded by either include or ignore patterns.
6. **Digest File Generation**
   - Creates a structured digest file with header information, directory tree, and file contents.
   - Each file section has start and end markers for reliable parsing.

#### Import Mode

1. **Parse Digest**
   - Parses the digest file, extracting file paths and content.
   - Enforces strict format validation, requiring each file section to have proper end markers.
2. **Security Checks**
   - Prevents path traversal attacks by ensuring all target paths resolve within the target directory.
3. **Checksum-Based Updates**
   - Calculates checksums for both digest content and existing file content (if present).
   - Updates files only if checksums don't match, avoiding unnecessary writes.
4. **Create/Update Files**
   - Creates directories as needed.
   - Writes files with their corresponding content from the digest.
5. **Reporting**
   - Provides detailed summary of created, updated, and unchanged files.

### Nuances & Limits

- **Size Limits**
  - Default `--max-size=10MB`, `--max-total-size=500MB`.
  - Prevents producing massive output files that are unwieldy or slow to load into an LLM.
- **Directory Depth**
  - Default `--max-depth=20`.
  - Prevents running forever on enormous or deeply nested repositories.
- **Symlinks**
  - Symlinks are tracked to prevent infinite loops from recursive links. Circular symlinks are detected and skipped.
  - Symlink targets are only followed if they point within the root directory being processed.
  - Broken symlinks or symlinks with permission errors generate warnings but do not stop the script.
- **File Type Detection**
  - A set of known text extensions is used (e.g., `.js`, `.py`, `.md`, etc.).
  - For files without known text extensions, a check for null characters is performed to determine if it's likely a text file.
- **Large Files**
  - Files over 1MB are read in chunks to avoid memory issues.
  - Large text files that exceed the max file size are noted in the digest but their content is not included.
- **Directory Tree Limits**
  - Maximum of 5,000 nodes are displayed to prevent overly large trees.
  - Tree view respects include/exclude patterns for a consistent view of the included files.
- **Import Security**
  - Path traversal prevention ensures files can only be created within the target directory.
  - Dry-run mode allows previewing changes before applying them.
  - Checksum comparison prevents unnecessary file updates.
- **Format Validation**
  - Digest files must follow the strict format with proper start and end markers.
  - Malformed entries are logged and skipped during import.

### License

This project is licensed under the [MIT License](LICENSE). You can use, modify, and distribute the code as long as the original license is included.

**Enjoy CodeDigest!**