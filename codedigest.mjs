#!/usr/bin/env node

/**
 * codedigest.mjs - A Node.js script to generate a digest of a directory's structure and file contents,
 *                  or import a digest to recreate the structure.
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  lstatSync, readdirSync, readlinkSync, openSync,
  readSync, closeSync
} from 'node:fs';

import {
  join, extname, dirname, relative, resolve, sep, normalize
} from 'node:path';

import { createHash } from 'node:crypto';

////////////////////////////////////////////////////////////////////////////////
// Constants
////////////////////////////////////////////////////////////////////////////////

const MAX_FILE_SIZE        = 10 * 1024 * 1024;  // 10 MB
const MAX_DIRECTORY_DEPTH  = 20;
const MAX_TOTAL_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB
const CHUNK_SIZE           = 1024 * 1024;       // 1 MB

// Regular expressions for digest parsing
const FILE_START_REGEX = /^### CODEDIGEST_FILE: (.+) ###$/;
// CHECKSUM_REGEX is removed as checksums are no longer stored in the digest
const FILE_END_REGEX = /^### CODEDIGEST_END ###$/;

/**
 * Default gitignore-style patterns to exclude.
 */
const DEFAULT_IGNORE_PATTERNS = new Set([
  '*.pyc',           '*.pyo',           '*.pyd',           '__pycache__',     '.pytest_cache',
  '.coverage',       '.tox',            '.nox',            '.mypy_cache',     '.ruff_cache',
  '.hypothesis',     'poetry.lock',     'Pipfile.lock',    'node_modules',    'bower_components',
  'package-lock.json','yarn.lock',      '.npm',            '.yarn',           '.pnpm-store',
  '*.class',         '*.jar',           '*.war',           '*.ear',           '*.nar',
  '.gradle/',        'build/',          '.settings/',      '.classpath',      'gradle-app.setting',
  '*.gradle',        '.project',        '*.o',             '*.obj',           '*.dll',
  '*.dylib',         '*.exe',           '*.lib',           '*.out',           '*.a',
  '*.pdb',           '.build/',         '*.xcodeproj/',    '*.xcworkspace/',  '*.pbxuser',
  '*.mode1v3',       '*.mode2v3',       '*.perspectivev3', '*.xcuserstate',   'xcuserdata/',
  '.swiftpm/',       '*.gem',           '.bundle/',        'vendor/bundle',   'Gemfile.lock',
  '.ruby-version',   '.ruby-gemset',    '.rvmrc',          'Cargo.lock',      '**/*.rs.bk',
  'target/',         'pkg/',            'obj/',            '*.suo',           '*.user',
  '*.userosscache',  '*.sln.docstates', 'packages/',       '*.nupkg',         'bin/',
  '.git',            '.svn',            '.hg',             '.gitignore',      '.gitattributes',
  '.gitmodules',     '*.svg',           '*.png',           '*.jpg',           '*.jpeg',
  '*.gif',           '*.ico',           '*.pdf',           '*.mov',           '*.mp4',
  '*.mp3',           '*.wav',           'venv',            '.venv',           'env',
  '.env',            'virtualenv',      '.idea',           '.vscode',         '.vs',
  '*.swo',           '*.swn',           '.settings',       '*.sublime-*',     '*.log',
  '*.bak',           '*.swp',           '*.tmp',           '*.temp',          '.cache',
  '.sass-cache',     '.eslintcache',    '.DS_Store',       'Thumbs.db',       'desktop.ini',
  'build',           'dist',            'target',          'out',             '*.egg-info',
  '*.egg',           '*.whl',           '*.so',            'site-packages',   '.docusaurus',
  '.next',           '.nuxt',           '*.min.js',        '*.min.css',       '*.map',
  '.terraform',      '*.tfstate*',      'vendor/',
]);

/**
 * ANSI escape codes for formatting console output.
 */
const FORMAT = {
  bold:   (text) => `\x1b[1m${text}\x1b[0m`,
  red:    (text) => `\x1b[31m${text}\x1b[0m`,
  green:  (text) => `\x1b[32m${text}\x1b[0m`,
  yellow: (text) => `\x1b[33m${text}\x1b[0m`,
  white:  (text) => `\x1b[37m${text}\x1b[0m`,
  gray:   (text) => `\x1b[90m${text}\x1b[0m`,
  invert: (text) => `\x1b[7m${text}\x1b[27m`,
};

////////////////////////////////////////////////////////////////////////////////
// Types
////////////////////////////////////////////////////////////////////////////////

/**
 * @typedef {Object} FileInfo
 * @property {string} path - The relative path of the file.
 * @property {string} content - The content of the file.
 * @property {number} size - The size of the file in bytes.
 */

/**
 * @typedef {Object} GitIgnoreRule
 * @property {string[]} segments
 * @property {boolean} negated
 * @property {boolean} directoryOnly
 * @property {boolean} anchored
 */

/**
 * @typedef {Object} ProcessingStats
 * @property {number} totalSize
 * @property {number} fileCount
 * @property {Set<string>} seenPaths
 * @property {Set<string>} seenSymlinks
 * @property {Array<{timestamp: string, message: string, stack?: string}>} errors
 * @property {number} skippedFiles
 * @property {number} filteredFiles
 * @property {number} nonTextFiles
 * @property {boolean} sizeLimitReached
 * @property {number} startTime
 * @property {Set<string>} matchedIgnorePatterns
 * @property {Set<string>} matchedIncludePatterns
 * @property {Object<string, number>} extensionSizes
 * @property {(e: Error) => void} addError
 */

/**
 * @typedef {Object} ProcessingOptions
 * @property {GitIgnoreRule[]} ignoreRules
 * @property {GitIgnoreRule[]} includeRules
 * @property {number} maxFileSize
 * @property {number} maxTotalSize
 * @property {number} maxDepth
 * @property {string} rootPath
 * @property {boolean} quiet
 * @property {boolean} ultraQuiet
 * @property {number} [currentDepth]
 */

////////////////////////////////////////////////////////////////////////////////
// Parsing Gitignore-Style Patterns
////////////////////////////////////////////////////////////////////////////////

function splitIntoSegments(pattern) {
  let segments = [];
  let current  = '';
  let escaped  = false;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];

    if (!escaped && ch === '\\') {
      escaped = true;
      continue;
    }

    if (!escaped && ch === '/') {
      if (current.length > 0) {
        segments.push(current);
      }
      current = '';
      continue;
    }

    current += ch;
    escaped = false;
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

function parseGitignore(text) {
  const lines = text.split(/\r?\n/);
  const rules = [];

  outerLoop:
  for (let rawLine of lines) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue outerLoop; // skip blank or comment lines
    }

    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    }

    let anchored = false;
    if (line.startsWith('/')) {
      anchored = true;
      line = line.slice(1);
    }

    let directoryOnly = false;
    if (line.endsWith('/')) {
      directoryOnly = true;
      line = line.slice(0, -1);
    }

    const segments = splitIntoSegments(line);

    rules.push({
      segments,
      negated,
      directoryOnly,
      anchored,
    });
  }

  return rules;
}

////////////////////////////////////////////////////////////////////////////////
// Matching Logic
////////////////////////////////////////////////////////////////////////////////

/**
 * "Last match wins": Return true if final match => non-negated, otherwise false.
 */
function matchPathByRules(filePath, rules, stats, matchedSetName) {
  const pathSegments = filePath.split('/').filter(Boolean);
  let matched = false;
  let matchedRule = null;

  for (const rule of rules) {
    if (matchesRule(pathSegments, rule)) {
      matched = !rule.negated;
      matchedRule = rule;
    }
  }

  if (matched && matchedRule && stats && matchedSetName) {
    const original = reconstructPattern(matchedRule);
    stats[matchedSetName].add(original);
  }
  return matched;
}

function matchesRule(pathSegments, rule) {
  if (rule.anchored) {
    return matchSegments(pathSegments, 0, rule.segments, 0, rule.directoryOnly);
  }
  // Non-anchored means it can match anywhere in the path
  // If rule has segments, match from any point in pathSegments
  if (rule.segments.length > 0) {
      for (let start = 0; start < pathSegments.length; start++) {
          if (matchSegments(pathSegments, start, rule.segments, 0, rule.directoryOnly)) {
              return true;
          }
      }
  } else {
      // If rule has no segments (e.g., just '*' or 'a?c'), it implicitly needs to match against *some* segment
      // This case might be less common or need refinement based on exact gitignore behavior for empty/root patterns.
      // Let's assume it should match against the last segment if not anchored? Or any? Let's stick to matching from any point.
       for (let start = 0; start < pathSegments.length; start++) {
          if (matchSegments(pathSegments, start, rule.segments, 0, rule.directoryOnly)) {
              return true;
          }
       }
  }

  return false;
}


function matchSegments(pathSegs, pIndex, patSegs, sIndex, directoryOnly) {
  while (sIndex < patSegs.length) {
      const token = patSegs[sIndex];

      if (token === '**') {
          sIndex++; // Consume the '**'
          if (sIndex === patSegs.length) {
              // '**' at the end matches everything remaining (including possibly nothing)
              // If directoryOnly, it must match at least one segment if pIndex is at end,
              // but gitignore '**/' means 'match directories anywhere', so the trailing / handles that check.
              // Let's refine: directoryOnly means the *entire* match must refer to a directory.
              // The check for directory status happens *outside* this matching logic.
              // For now, '**' at end just means match is successful from here.
               return true;
          }
          // Try matching the rest of the pattern (patSegs[sIndex:]) against
          // all possible remaining path segments (pathSegs[pIndex:]).
          // This involves backtracking.
          while (pIndex < pathSegs.length) {
              if (matchSegments(pathSegs, pIndex, patSegs, sIndex, directoryOnly)) {
                  return true;
              }
              pIndex++;
          }
          // If '**' is followed by something, but we've run out of path segments,
          // see if the rest of the pattern can match an empty sequence (e.g., another '**').
          return matchSegments(pathSegs, pIndex, patSegs, sIndex, directoryOnly);
      }

      // If we need a path segment but don't have one
      if (pIndex === pathSegs.length) {
          return false;
      }

      // If the current path segment doesn't match the pattern segment
      if (!segmentMatch(pathSegs[pIndex], token)) {
          return false;
      }

      // Matched one segment, move to the next in both path and pattern
      pIndex++;
      sIndex++;
  }

  // If we consumed the whole pattern, the match is successful only if we
  // also consumed the whole path (unless the pattern is directoryOnly,
  // in which case matching a prefix of the path is sometimes okay, handled externally).
  // For gitignore, generally, a pattern like 'foo/bar' should match 'foo/bar' exactly,
  // not 'foo/bar/baz'. The 'directoryOnly' flag handles the 'foo/' case.
   return pIndex === pathSegs.length;
}


function segmentMatch(pathSegment, patternSegment) {
  // Fast path for literal match
  if (!patternSegment.includes('*') && !patternSegment.includes('?')) {
    return pathSegment === patternSegment;
  }
  // Convert glob pattern to regex
  let regexStr = '';
  for (let i = 0; i < patternSegment.length; i++) {
    const ch = patternSegment[i];
    if (ch === '*') {
      regexStr += '[^/]*'; // Matches zero or more characters except '/'
    } else if (ch === '?') {
      regexStr += '[^/]'; // Matches exactly one character except '/'
    } else {
      // Escape regex special characters
      regexStr += escapeRegex(ch);
    }
  }
  const re = new RegExp(`^${regexStr}$`);
  return re.test(pathSegment);
}


function escapeRegex(ch) {
  // Escape characters with special meaning in regex
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function reconstructPattern(rule) {
  let p = rule.segments.map(s => s.replace(/\\/g, '\\\\').replace(/\//g, '\\/')).join('/');
  if (rule.directoryOnly) p += '/';
  if (rule.anchored) p = '/' + p;
  if (rule.negated) p = '!' + p;
  return p;
}

////////////////////////////////////////////////////////////////////////////////
// Include & Ignore Checking
////////////////////////////////////////////////////////////////////////////////

/**
 * Return true if the path matches the ignoreRules (i.e. "excluded").
 */
function isPathExcluded(filePath, ignoreRules, stats) {
  return matchPathByRules(filePath, ignoreRules, stats, 'matchedIgnorePatterns');
}

/**
 * Return true if the path matches the includeRules (i.e. "included").
 * If no includeRules, everything is included by default.
 */
function isPathIncluded(filePath, includeRules, stats) {
  if (!includeRules || includeRules.length === 0) {
    return true;
  }
  return matchPathByRules(filePath, includeRules, stats, 'matchedIncludePatterns');
}

////////////////////////////////////////////////////////////////////////////////
// Stats
////////////////////////////////////////////////////////////////////////////////

function createStats() {
  return {
    totalSize:             0,
    fileCount:             0,
    seenPaths:             new Set(),
    seenSymlinks:          new Set(),
    errors:                [],
    skippedFiles:          0,
    filteredFiles:         0,
    nonTextFiles:          0,
    sizeLimitReached:      false,
    startTime:             Date.now(),
    matchedIgnorePatterns: new Set(),
    matchedIncludePatterns: new Set(),
    extensionSizes:        {},

    addError(error) {
      this.errors.push({
        timestamp: new Date().toISOString(),
        message:   error.message,
        stack:     error.stack,
      });
    },
  };
}

////////////////////////////////////////////////////////////////////////////////
// File & Symlink Handling
////////////////////////////////////////////////////////////////////////////////

function readFileContent(filePath, maxFileSize) {
  try {
    const stats = lstatSync(filePath);

    if (stats.size > maxFileSize) {
      return `[File too large to display, size: ${formatBytes(stats.size)}]`;
    }

    // Perform text check before attempting to read potentially huge binary files fully
    if (!isTextFile(filePath, stats.size)) {
       return '[Non-text file]';
    }

    // Now read the content (we know it's likely text and within size limits)
    if (stats.size > CHUNK_SIZE) {
        // Read large text files in chunks to avoid huge buffer allocation
        const fd = openSync(filePath, 'r');
        let content = '';
        const buffer = Buffer.alloc(CHUNK_SIZE);
        let bytesRead;
        try {
            while ((bytesRead = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
                content += buffer.toString('utf8', 0, bytesRead);
                // Optional: Add a check here to break if content exceeds some reasonable limit,
                // even if file size was initially okay (e.g., guard against decompression bombs if format allowed)
            }
        } finally {
            closeSync(fd);
        }
        return content;
    } else {
        // Read smaller files directly
        return readFileSync(filePath, 'utf-8');
    }
  } catch (error) {
    // Log the error more visibly during file read failure
    console.error(FORMAT.red(`Error reading file ${filePath}: ${error.message}`));
    return `[Error reading file: ${error.message}]`; // Indicate error in the digest content
  }
}

function isTextFile(filePath, fileSize = -1) {
  const textExtensions = new Set([
    '.txt',  '.md',   '.log',  '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml',
    '.ini',  '.cfg',  '.toml', '.sh',  '.bash', '.zsh', '.csh', '.bat', '.cmd',
    '.ps1',  '.py',   '.js',   '.mjs', '.ts',  '.jsx', '.tsx', '.html', '.htm',
    '.css',  '.scss', '.sass', '.less','.styl','.php', '.java', '.rb',   '.go',
    '.rs',   '.c',    '.h',    '.cpp', '.hpp', '.cs',  '.swift','.kt',   '.kts',
    '.scala','.pl',   '.pm',   '.r',   '.lua', '.sql', '.gitignore', '.gitattributes',
    '.gitmodules', 'dockerfile', 'makefile', '.editorconfig', '.env'
    // Add more known text extensions if needed
  ]);

  // Check by extension first (fastest)
  if (textExtensions.has(extname(filePath).toLowerCase())) {
    return true;
  }

  // For files without recognized text extensions, try reading a small chunk
  // Avoid reading large files just to check for null bytes
  const sizeToRead = fileSize === -1 ? 4096 : Math.min(fileSize, 4096);
  if (sizeToRead === 0) return true; // Empty file is considered text

  let fd;
  try {
    const buffer = Buffer.alloc(sizeToRead);
    fd = openSync(filePath, 'r');
    const bytesRead = readSync(fd, buffer, 0, sizeToRead, 0);
    closeSync(fd);
    fd = null; // Prevent double close in finally

    // Check for null bytes in the buffer
    return buffer.indexOf(0, 0, bytesRead) === -1;

  } catch (error) {
     // If we can't read it, assume it's not text or inaccessible
    if (!error.message.includes('ENOENT')) { // Don't warn for files that vanish mid-scan
       console.warn(FORMAT.yellow(`Could not check file type for ${filePath}: ${error.message}`));
    }
    return false;
  } finally {
      if (fd !== null && fd !== undefined) { // Ensure fd is defined and not null
          try { closeSync(fd); } catch (e) { /* ignore close error */ }
      }
  }
}

function formatBytes(bytes, decimals = 2) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Invalid size';
  if (bytes === 0) return '0 Bytes';
  const k     = 1024;
  const dm    = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i     = Math.floor(Math.log(bytes) / Math.log(k));
  // Ensure i is within the bounds of the sizes array
  const index = Math.min(i, sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, index)).toFixed(dm))} ${sizes[index]}`;
}


function processFile(filePath, maxFileSize, stats, files, rootPath, options) {
  try {
    const fileStats = lstatSync(filePath);
    const fileSize = fileStats.size;

    if (fileSize > maxFileSize) {
      stats.skippedFiles++;
      if (!options.quiet && !options.ultraQuiet) {
        console.warn(FORMAT.yellow(`Skipping file larger than maxFileSize (${formatBytes(maxFileSize)}): ${relative(rootPath, filePath)} (${formatBytes(fileSize)})`));
      }
      return;
    }

    if (stats.totalSize + fileSize > options.maxTotalSize) {
      stats.sizeLimitReached = true;
      if (!options.quiet && !options.ultraQuiet) {
        console.warn(FORMAT.yellow(`Total size limit (${formatBytes(options.maxTotalSize)}) reached, skipping: ${relative(rootPath, filePath)}`));
      }
      return;
    }

    // Check if text file *before* adding size, so non-text files don't count towards total size
    if (!isTextFile(filePath, fileSize)) {
        stats.nonTextFiles++;
        if (!options.quiet && !options.ultraQuiet) {
            console.log(FORMAT.gray(`Skipping non-text file: ${relative(rootPath, filePath)}`));
        }
        return;
    }

    // Passed checks, now add size and count
    stats.totalSize += fileSize;
    stats.fileCount++;

    const ext = extname(filePath).toLowerCase() || '.<no_ext>'; // Handle files with no extension
    stats.extensionSizes[ext] = (stats.extensionSizes[ext] || 0) + fileSize;

    const relativePath = relative(rootPath, filePath).split(sep).join('/'); // Ensure forward slashes
    files.push({
      path:    relativePath,
      content: readFileContent(filePath, maxFileSize), // Read content only if included
      size:    fileSize,
    });

    if (!options.quiet && !options.ultraQuiet) {
      console.log(FORMAT.green(`Added: ${relativePath} (${formatBytes(fileSize)})`));
    }
  } catch (error) {
     if (error.code === 'ENOENT') {
        // File might have been deleted between readdir and lstat, common race condition
        if (!options.ultraQuiet) {
             console.warn(FORMAT.yellow(`File vanished before processing: ${relative(rootPath, filePath)}`));
        }
     } else {
        stats.addError(error);
        console.error(FORMAT.red(`Error processing file ${relative(rootPath, filePath)}: ${error.message}`));
     }
  }
}


function processSymlink(entryPath, targetPath, stats, files, options) {
  const resolvedEntryPath = resolve(entryPath);
  const resolvedTargetPath = resolve(targetPath); // Resolve target fully

  // Basic cycle detection for symlinks pointing within the scan root
  const symlinkKey = `${resolvedEntryPath}->${resolvedTargetPath}`;
  if (stats.seenSymlinks.has(symlinkKey)) {
    if (!options.ultraQuiet) {
      console.warn(FORMAT.yellow(`Symlink cycle detected, skipping: ${relative(options.rootPath, entryPath)} -> ${relative(options.rootPath, targetPath)}`));
    }
    return []; // Return empty array as expected by caller
  }
  stats.seenSymlinks.add(symlinkKey);


  try {
    // Use lstat on the *target* to determine if it's a file or directory
    // stat() would follow the link again, lstat() checks the target itself
    const targetStat = lstatSync(resolvedTargetPath);

    // Important: Check if the symlink target points *outside* the root directory scan area.
    // Decide on policy: Follow? Skip? For digest, probably skip to avoid unexpected content.
    if (!resolvedTargetPath.startsWith(options.rootPath + sep) && resolvedTargetPath !== options.rootPath) {
        if (!options.ultraQuiet) {
            console.warn(FORMAT.yellow(`Skipping symlink pointing outside root: ${relative(options.rootPath, entryPath)} -> ${targetPath}`));
        }
        return [];
    }


    // Now handle based on target type
    if (targetStat.isDirectory()) {
      // Recurse into the directory the symlink points to
      // Pass the original entryPath's depth + 1
      return processDirectory(resolvedTargetPath, { ...options, currentDepth: options.currentDepth + 1 }, stats);
    } else if (targetStat.isFile()) {
       // Process the file the symlink points to, but use the symlink's path for relative path calculation
       // Check includes/excludes based on the *symlink's* path first
       const relativeLinkPath = relative(options.rootPath, entryPath).split(sep).join('/');
       if (isPathExcluded(relativeLinkPath, options.ignoreRules, stats)) {
           stats.filteredFiles++;
           return [];
       }
       if (!isPathIncluded(relativeLinkPath, options.includeRules, stats)) {
           stats.filteredFiles++;
           return [];
       }
       // If included, process the *target* file
       processFile(resolvedTargetPath, options.maxFileSize, stats, files, options.rootPath, options);
       return []; // processFile adds to 'files' directly, return empty here
    } else {
       // Target is something else (socket, fifo, etc.) - skip
       if (!options.ultraQuiet) {
            console.warn(FORMAT.gray(`Skipping symlink to non-file/dir: ${relative(options.rootPath, entryPath)} -> ${targetPath}`));
       }
       return [];
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
       if (!options.ultraQuiet) {
         console.warn(FORMAT.yellow(`Broken symlink: ${relative(options.rootPath, entryPath)} -> ${targetPath}`));
       }
    } else if (err.code === 'EACCES') {
       if (!options.ultraQuiet) {
         console.warn(FORMAT.red(`Permission error accessing symlink target: ${relative(options.rootPath, entryPath)} -> ${targetPath}`));
       }
       stats.addError(new Error(`Permission error for symlink target ${targetPath}: ${err.message}`));
    } else {
       if (!options.ultraQuiet) {
          console.error(FORMAT.red(`Error processing symlink ${relative(options.rootPath, entryPath)}: ${err.message}`));
       }
       stats.addError(err);
    }
    return []; // Return empty array on error
  }
}


////////////////////////////////////////////////////////////////////////////////
// Directory Processing
////////////////////////////////////////////////////////////////////////////////

function processDirectory(
  dirPath,
  options, // Destructure options for clarity
  stats = createStats()
) {
   const {
    ignoreRules,
    includeRules,
    maxFileSize     = MAX_FILE_SIZE,
    maxTotalSize    = MAX_TOTAL_SIZE_BYTES,
    maxDepth        = MAX_DIRECTORY_DEPTH,
    currentDepth    = 0,
    rootPath,       // Expect rootPath to always be provided and resolved
    quiet           = false,
    ultraQuiet      = false,
  } = options;


  /** @type {FileInfo[]} */
  const files = [];

  if (currentDepth > maxDepth) {
    if (!ultraQuiet) {
      console.warn(FORMAT.yellow(`Max directory depth (${maxDepth}) reached, stopping descent at: ${relative(rootPath, dirPath)}`));
    }
    return files; // Return collected files up to this point
  }

  const resolvedDirPath = resolve(dirPath);

  // Cycle detection for directories (via symlinks mostly, but also hard links if OS supports dir hard links)
  if (stats.seenPaths.has(resolvedDirPath)) {
    if (!ultraQuiet) {
      console.warn(FORMAT.yellow(`Directory cycle detected, skipping: ${relative(rootPath, dirPath)}`));
    }
    return files;
  }
  stats.seenPaths.add(resolvedDirPath);

  let entries = [];
  try {
    entries = readdirSync(resolvedDirPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'EACCES') {
       if (!ultraQuiet) {
          console.error(FORMAT.red(`Permission error reading directory ${relative(rootPath, dirPath)}: ${error.message}`));
       }
       stats.addError(new Error(`Permission error reading directory ${resolvedDirPath}: ${error.message}`));
    } else if (error.code !== 'ENOENT') { // Ignore if dir vanished
       if (!ultraQuiet) {
          console.error(FORMAT.red(`Error reading directory ${relative(rootPath, dirPath)}: ${error.message}`));
       }
       stats.addError(error);
    } // else: Ignore ENOENT quietly
    return files; // Cannot proceed with this directory
  }

  for (const entry of entries) {
    if (stats.sizeLimitReached) {
       // No need for message here, already warned in processFile
       break; // Stop processing entries in this directory
    }

    const entryPath = join(resolvedDirPath, entry.name); // Use resolved dir path
    // Calculate relative path from the original root for consistent filtering/output
    const relativePath = relative(rootPath, entryPath);
    // Ensure forward slashes for matching rules
    const forwardSlashed = normalize(relativePath).split(sep).join('/');

    // --- Filtering Logic ---

    // 1. Check if the path itself is ignored.
    // Important: For directories, check if the *directory path* matches an ignore rule.
    // If a directory is ignored, we don't recurse into it at all.
    let isDir = entry.isDirectory();
    let isLink = entry.isSymbolicLink();
    let isIgnored = isPathExcluded(forwardSlashed, ignoreRules, stats);

    if (isIgnored) {
      stats.filteredFiles++;
      // Log only if verbose enough and if it wasn't the output file itself (already excluded silently)
      // Requires checking if the ignored path matches the output file pattern added earlier if desired.
      if (!quiet && !ultraQuiet /* && !isOutputRelPath */) {
         console.log(FORMAT.gray(`Excluded by pattern: ${forwardSlashed}${isDir ? '/' : ''}`));
      }
      continue; // Skip this entry entirely
    }

    // 2. Handle entry types
    if (isLink) {
      try {
        // Resolve the target path relative to the directory containing the link
        const targetPath = readlinkSync(entryPath);
        // The target needs to be resolved fully for `processSymlink`
        const resolvedTargetPath = resolve(dirname(entryPath), targetPath);

        // Pass the *current* depth, processSymlink will handle depth increment if it recurses
        const symlinkedFiles = processSymlink(entryPath, resolvedTargetPath, stats, files, {
            ...options, // Pass all options down
            currentDepth: currentDepth // Depth increases *inside* processSymlink if it calls processDirectory
        });
        files.push(...symlinkedFiles); // Add files found by following the link (if any)

      } catch (error) {
          // Handle errors from readlink itself (e.g., permissions)
          if (error.code === 'ENOENT' && !ultraQuiet) {
             console.warn(FORMAT.yellow(`Symlink vanished before readlink: ${forwardSlashed}`));
          } else if (error.code !== 'ENOENT') {
             if (!ultraQuiet) {
                 console.error(FORMAT.red(`Error reading symlink ${forwardSlashed}: ${error.message}`));
             }
             stats.addError(error);
          } // Ignore ENOENT quietly
      }
      continue; // Handled symlink, move to next entry
    }

    if (isDir) {
      // Recurse into subdirectory. Pass depth+1.
      const subFiles = processDirectory(
        entryPath,
        { ...options, currentDepth: currentDepth + 1 }, // Pass options, increment depth
        stats // Pass the same stats object
      );
      files.push(...subFiles);
      continue; // Handled directory, move to next entry
    }

    // 3. Handle Files: Check include patterns *only* for files.
    if (entry.isFile()) {
        if (!isPathIncluded(forwardSlashed, includeRules, stats)) {
          stats.filteredFiles++;
           if (!quiet && !ultraQuiet) {
               console.log(FORMAT.gray(`Filtered out (no include match): ${forwardSlashed}`));
           }
          continue; // Skip file, does not match include rules
        }

        // If we get here, it's a file that is:
        // - Not ignored by ignore rules
        // - Matches include rules (or no include rules specified)
        processFile(entryPath, maxFileSize, stats, files, rootPath, options);
    } else {
        // Entry is not a file, directory, or symlink (socket, fifo, etc.)
        if (!ultraQuiet) {
            console.log(FORMAT.gray(`Skipping unsupported file type: ${forwardSlashed}`));
        }
    }
  } // End loop through entries

  return files;
}


////////////////////////////////////////////////////////////////////////////////
// Directory Tree
////////////////////////////////////////////////////////////////////////////////

function generateDirectoryTree(
  dirPath,
  ignoreRules,
  includeRules,
  maxDepth,
  currentDepth = 0,
  prefix = '',
  rootPath = dirPath, // Initialize rootPath here if called externally
  result = { content: '', truncated: false, count: 0 }, // Add count to limit nodes
  ultraQuiet = false,
  options // Pass ProcessingOptions for consistency, though only need rules/depth
) {
  const MAX_TREE_NODES = 5000; // Limit tree complexity

  if (currentDepth > maxDepth || result.truncated || result.count > MAX_TREE_NODES) {
      if (result.count > MAX_TREE_NODES && !result.truncated) {
          result.content += `${prefix}[Tree truncated - too many entries]\n`;
          result.truncated = true;
      }
      // Don't add depth message if already truncated for other reasons
      else if (currentDepth > maxDepth && !result.truncated) {
          result.content += `${prefix}[Tree truncated - max depth reached]\n`;
          result.truncated = true;
      }
    return result.content; // Return immediately if limits reached
  }

  let entries = [];
  const resolvedDirPath = resolve(dirPath); // Use resolved path
  try {
      // Use resolved path for reading directory
      entries = readdirSync(resolvedDirPath, { withFileTypes: true });
  } catch (error) {
      // Avoid crashing tree generation on permission errors
      if (!ultraQuiet) {
          const relPath = relative(rootPath, resolvedDirPath);
          console.error(FORMAT.red(`Error reading directory for tree view ${relPath}: ${error.message}`));
      }
      result.content += `${prefix}└── [Error reading directory: ${error.code || error.message}]\n`;
      result.count++;
      return result.content; // Don't proceed further down this branch
  }

  // Filter entries based on ignore/include rules for *display* in the tree
  const displayEntries = entries.filter((entry) => {
    const entryPath = join(resolvedDirPath, entry.name);
    const relPath = relative(rootPath, entryPath);
    const fwd = normalize(relPath).split(sep).join('/');

    // If ignored, skip entirely from the tree view
    if (isPathExcluded(fwd, ignoreRules, null)) { // Pass null for stats - not collecting stats here
      return false;
    }

    // If it's a directory or symlink, always include in the tree for structure,
    // unless it was explicitly ignored above. Recursion will handle nested filtering.
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      return true;
    }

    // If it's a file, only include it in the tree if it matches include rules
    // (or if there are no include rules).
    if (entry.isFile()) {
       return isPathIncluded(fwd, includeRules, null); // Pass null for stats
    }

    // Ignore other types (sockets, etc.) in the tree view
    return false;
  }).sort((a, b) => {
      // Sort directories first, then files, then alphabetically
      const aIsDir = a.isDirectory() || a.isSymbolicLink(); // Treat links like dirs for sorting
      const bIsDir = b.isDirectory() || b.isSymbolicLink();
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.name.localeCompare(b.name); // Alphabetical for same type
  });


  displayEntries.forEach((entry, index) => {
    // Check truncation conditions *before* processing the entry
    if (result.truncated || result.count > MAX_TREE_NODES) {
        if (!result.truncated) { // Add truncation message only once
            result.content += `${prefix}${isLast ? '└── ' : '├── '}[Tree truncated - too many entries]\n`;
            result.truncated = true;
        }
        return; // Stop processing further entries at this level
    }

    const isLast = index === displayEntries.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const entryPath = join(resolvedDirPath, entry.name); // Use resolved path
    let displayName = entry.name;
    let targetInfo = '';

    if (entry.isDirectory()) {
      displayName += '/';
    } else if (entry.isSymbolicLink()) {
        displayName += ' ->';
        try {
           const target = readlinkSync(entryPath);
           // Try to resolve relative to root for display clarity if possible
           const absTarget = resolve(dirname(entryPath), target);
           if (absTarget.startsWith(rootPath + sep)) {
               targetInfo = ` ${relative(rootPath, absTarget).split(sep).join('/')}`;
           } else {
               targetInfo = ` ${target}`; // Show raw target if outside root
           }

        } catch (e) {
           targetInfo = ' [Broken Link]';
        }
    }
    // Only add file size if not quiet/ultraQuiet? Maybe always add for tree? Let's add it.
    // else if (entry.isFile()) {
    //    try {
    //       const size = lstatSync(entryPath).size;
    //       targetInfo = ` (${formatBytes(size)})`;
    //    } catch (e) { /* ignore stat error for tree */ }
    // }


    result.content += `${prefix}${connector}${displayName}${targetInfo}\n`;
    result.count++;


    // Recurse ONLY if it's a directory and we haven't hit limits
    if (entry.isDirectory() && !result.truncated) {
      const newPrefix = `${prefix}${isLast ? '    ' : '│   '}`;
      generateDirectoryTree(
        entryPath, // Pass resolved path for recursion
        ignoreRules,
        includeRules,
        maxDepth,
        currentDepth + 1, // Increment depth
        newPrefix,
        rootPath, // Pass rootPath consistently
        result, // Pass the *same* result object
        ultraQuiet,
        options // Pass options down
      );
    }
    // Do NOT recurse into symlink targets for the *tree view* to avoid loops/complexity
    // The processDirectory function handles following links for content gathering.
  });

  return result.content; // Return the final accumulated content
}


////////////////////////////////////////////////////////////////////////////////
// Summary & Reporting
////////////////////////////////////////////////////////////////////////////////

function calculateExtensionPercentages(extensionSizes, totalSize) {
  if (totalSize === 0) return {}; // Avoid division by zero

  const percentages = {};
  let otherSize = 0;
  const MIN_PERCENTAGE_THRESHOLD = 0.5; // Group small extensions

  // Calculate percentages
  for (const ext in extensionSizes) {
    const percent = (extensionSizes[ext] / totalSize) * 100;
    if (percent >= MIN_PERCENTAGE_THRESHOLD) {
      percentages[ext] = percent;
    } else {
      otherSize += extensionSizes[ext];
    }
  }

  // Add 'other' category if needed
  if (otherSize > 0) {
     const otherPercent = (otherSize / totalSize) * 100;
     // Only show 'other' if it's significant enough or if there are few main categories
     if (otherPercent >= MIN_PERCENTAGE_THRESHOLD || Object.keys(percentages).length < 5) {
        percentages['.other'] = otherPercent;
     } else {
         // If 'other' is tiny and there are many main categories, distribute it slightly?
         // Or just ignore it for cleaner graph? Let's ignore small remainder.
     }
  }

  return percentages;
}

function generateBarGraph(extensionPercentages) {
  const { white, green, gray } = FORMAT;
  const barLength = 30; // Make bar slightly longer
  let graph = '';

  const sorted = Object.entries(extensionPercentages)
    .sort(([, a], [, b]) => b - a); // Sort descending by percentage

  if (sorted.length === 0) {
      return gray('  (No text files included)');
  }

  for (const [ext, percent] of sorted) {
    if (percent === 0) continue; // Skip zero percent entries if any crept in
    const filledBars = Math.max(1, Math.round((percent / 100) * barLength)); // Ensure at least one bar if > 0%
    const emptyBars  = Math.max(0, barLength - filledBars);
    const bar        = green('█'.repeat(filledBars)) + gray('─'.repeat(emptyBars)); // Use different colors
    graph += `  ${white(ext.padEnd(10))}: [${bar}] ${percent.toFixed(1)}%\n`;
  }
  return graph.trimEnd(); // Remove trailing newline
}

function generateSummary(path, stats, options, outputFile) {
  const { bold, red, green, yellow, white, gray, invert } = FORMAT;
  const executionTime = Date.now() - stats.startTime;

  const extensionPercentages = calculateExtensionPercentages(
    stats.extensionSizes,
    stats.totalSize
  );
  const barGraph = generateBarGraph(extensionPercentages);

  // Helper to format pattern lists
  const formatPatternList = (patternSet) => {
      if (patternSet.size === 0) return gray('  None');
      return Array.from(patternSet)
          .map(p => `  ${gray(p)}`)
          .join('\n');
  };

  return `
${invert(bold(' Code Digest Summary '))}
${white('Processed Path:')}          ${gray(resolve(path))}
${white('Output File:')}             ${gray(outputFile ? resolve(outputFile) : 'N/A')}
${white('Execution Time:')}          ${yellow((executionTime / 1000).toFixed(2))} ${gray('seconds')}

${invert(bold(' Content Stats '))}
${white('Text Files Included:')}     ${green(stats.fileCount.toString())}
${white('Total Size Included:')}     ${yellow(formatBytes(stats.totalSize))} ${stats.sizeLimitReached ? red('(Limit Reached)') : ''}
${white('Files Excluded:')}
${white('  by ignore pattern:')}    ${red(stats.filteredFiles.toString())}
${white('  non-text files:')}       ${red(stats.nonTextFiles.toString())}
${white('  size > max_file:')}      ${red(stats.skippedFiles.toString())}

${invert(bold(' Configuration '))}
${white('Max File Size:')}           ${yellow(formatBytes(options.maxFileSize))}
${white('Max Total Size:')}          ${yellow(formatBytes(options.maxTotalSize))}
${white('Max Directory Depth:')}     ${yellow(options.maxDepth)}
${white('Follow Symlinks:')}         ${yellow('Yes (within root)')}

${invert(bold(' Filters Applied '))}
${bold('Ignore Patterns Matched:')}
${formatPatternList(stats.matchedIgnorePatterns)}
${bold('Include Patterns Matched:')}
${formatPatternList(stats.matchedIncludePatterns)}

${invert(bold(' Size by Extension (Included Text Files) '))}
${barGraph}

${invert(bold(` Errors (${stats.errors.length}) `))}
${
    stats.errors.length
      ? stats.errors.map((err) => gray(`  ${err.timestamp}: ${err.message}`)).join('\n')
      : gray('  No errors reported.')
}
`;
}


////////////////////////////////////////////////////////////////////////////////
// Import Digest
////////////////////////////////////////////////////////////////////////////////

/**
 * Parse a digest file and extract file paths and content.
 * Assumes strict format where every file block ends with CODEDIGEST_END.
 * Checksum lines are ignored.
 *
 * @param {string} digestContent - Content of the digest file
 * @returns {Array<{path: string, content: string}>} - Array of file info (path and content only)
 */
function parseDigestContent(digestContent) {
  const lines = digestContent.split(/\r?\n/);
  /** @type {Array<{path: string, content: string}>} */
  const files = [];

  let currentFile = null;
  let currentContent = [];
  // Removed currentChecksum and inHeader logic related to checksum

  for (const line of lines) {
    const fileMatch = line.match(FILE_START_REGEX);
    // Removed checksumMatch
    const endMatch = line.match(FILE_END_REGEX);

    if (fileMatch) {
      // New file section starts
      if (currentFile !== null) {
        // If we were in a file block but didn't see an END marker, it's malformed.
        console.warn(FORMAT.yellow(`Warning: Malformed entry detected. File section for '${currentFile}' started but was interrupted by a new file section before an END marker.`));
      }
      // Reset for new file
      currentFile = fileMatch[1];
      currentContent = [];
      // Removed checksum reset
    }
    // Removed checksum parsing logic
    else if (currentFile !== null && endMatch) {
      // End of file section - push the file path and content.
      files.push({
        path: currentFile,
        content: currentContent.join('\n'),
        // checksum property removed
      });
      // Reset state
      currentFile = null;
      currentContent = [];
      // Removed checksum reset
    } else if (currentFile !== null) {
      // Line belongs to the current file's content
      // Check if it's the checksum line and ignore it if present (for backward compatibility)
      if (!line.match(/^### CHECKSUM: [a-f0-9]+ ###$/)) {
          currentContent.push(line);
      }
    }
    // Ignore lines outside of file blocks or checksum lines
  }

  // Check if the loop ended while inside a file block without an END marker
  if (currentFile !== null) {
      console.warn(FORMAT.yellow(`Warning: Malformed digest. End of input reached while processing file section for '${currentFile}' without an END marker.`));
      // Do NOT add this potentially incomplete file based on the strict format requirement.
  }

  return files;
}


/**
 * Import files from a digest and create/update files in the target directory.
 * Compares checksum of digest content against checksum of existing file content.
 *
 * @param {string} digestFilePath - Path to the digest file
 * @param {string} targetDir - Directory where files should be created/updated
 * @param {boolean} dryRun - If true, don't actually create/update files
 * @param {boolean} quiet - If true, reduce console output
 * @returns {Object} Summary of import operation
 */
function importDigest(digestFilePath, targetDir, dryRun, quiet) {
  const summary = {
    created: [],
    updated: [],
    unchanged: [],
    skippedOutsideTarget: [],
    errors: []
    // checksumMismatch category removed
  };

  if (!existsSync(digestFilePath)) {
    throw new Error(`Digest file not found: ${digestFilePath}`);
  }

   const resolvedBaseTargetDir = resolve(targetDir);
   if (!quiet) console.log(`Resolved target directory: ${resolvedBaseTargetDir}`);

  // Ensure the base target directory exists if not in dry run
  if (!dryRun && !existsSync(resolvedBaseTargetDir)) {
      try {
          mkdirSync(resolvedBaseTargetDir, { recursive: true });
          if (!quiet) console.log(FORMAT.green(`Created base target directory: ${resolvedBaseTargetDir}`));
      } catch (error) {
          throw new Error(`Failed to create target directory ${resolvedBaseTargetDir}: ${error.message}`);
      }
  }

  const digestContent = readFileSync(digestFilePath, 'utf-8');
  const files = parseDigestContent(digestContent); // Parses path and content only

  if (!quiet) console.log(`Parsed ${files.length} file entries from digest`);

  for (const file of files) {
    try {
      // --- Path Traversal Prevention ---
      const initialTargetPath = join(resolvedBaseTargetDir, file.path);
      const resolvedTargetPath = resolve(initialTargetPath);
      if (!(resolvedTargetPath.startsWith(resolvedBaseTargetDir + sep) || resolvedTargetPath === resolvedBaseTargetDir)) {
          summary.skippedOutsideTarget.push(file.path);
          if (!quiet) console.error(FORMAT.red(`Security Risk: Skipping ${file.path} - path resolves outside target directory '${resolvedBaseTargetDir}'`));
          continue; // Skip this file
      }
      // --- End Path Traversal Prevention ---

      const targetFileDir = dirname(resolvedTargetPath);
      const fileExists = existsSync(resolvedTargetPath);

      // Calculate checksum of the content *from the digest*
      const digestContentChecksum = calculateChecksum(file.content);

      let action = 'unknown'; // 'create', 'update', 'unchanged', 'error'
      let existingFileChecksum = null;

      if (fileExists) {
          try {
              const existingContent = readFileSync(resolvedTargetPath, 'utf-8');
              existingFileChecksum = calculateChecksum(existingContent);

              if (digestContentChecksum === existingFileChecksum) {
                  action = 'unchanged';
                  summary.unchanged.push(file.path);
              } else {
                  action = 'update';
                  summary.updated.push(file.path);
              }
          } catch (readError) {
              action = 'error';
              summary.errors.push({ path: file.path, error: `Could not read existing file for comparison: ${readError.message}` });
              if (!quiet) console.error(FORMAT.red(`Error reading existing file ${file.path} for comparison: ${readError.message}`));
          }
      } else {
          action = 'create';
          summary.created.push(file.path);
      }

      // Perform actions based on comparison and dryRun status
      if (action === 'error') {
          continue; // Skip if reading existing file failed
      }

      if (dryRun) {
          // Log intended actions
          if (action === 'create') {
              if (!existsSync(targetFileDir)) {
                 if (!quiet) console.log(`Would create directory: ${relative(process.cwd(), targetFileDir) || '.'}`);
              }
              if (!quiet) console.log(`Would create: ${file.path}`);
          } else if (action === 'update') {
              if (!quiet) console.log(`Would update: ${file.path} (Checksum differs: Digest ${digestContentChecksum} vs Disk ${existingFileChecksum})`);
          } else if (action === 'unchanged') {
              // Optionally log unchanged files if verbose enough
              // if (!quiet) console.log(FORMAT.gray(`Would leave unchanged: ${file.path} (Checksum matches: ${digestContentChecksum})`));
          }
      } else { // Actual import
          if (action === 'create' || action === 'update') {
              // Ensure directory exists before writing
              if (!existsSync(targetFileDir)) {
                 try {
                    mkdirSync(targetFileDir, { recursive: true });
                 } catch (mkdirError) {
                     summary.errors.push({ path: file.path, error: `Failed to create directory ${targetFileDir}: ${mkdirError.message}` });
                     if (!quiet) console.error(FORMAT.red(`Error creating directory for ${file.path}: ${mkdirError.message}`));
                     continue; // Skip this file if directory can't be made
                 }
              }
              // Write the file content from the digest
              try {
                  writeFileSync(resolvedTargetPath, file.content);
                  if (!quiet) {
                      if (action === 'create') {
                          console.log(FORMAT.green(`Created: ${file.path}`));
                      } else { // action === 'update'
                          console.log(FORMAT.yellow(`Updated: ${file.path}`));
                      }
                  }
              } catch (writeError) {
                  summary.errors.push({ path: file.path, error: `Failed to write file: ${writeError.message}` });
                  if (!quiet) console.error(FORMAT.red(`Error writing file ${file.path}: ${writeError.message}`));
              }
          } else if (action === 'unchanged') {
              // Log unchanged only if verbose?
              // if (!quiet) console.log(FORMAT.gray(`Unchanged: ${file.path}`));
          }
      }
    } catch (error) {
      // Catch unexpected errors during the processing of a single file entry
      summary.errors.push({ path: file.path || 'Unknown path', error: error.message });
      if (!quiet) console.error(FORMAT.red(`Error processing entry for ${file.path || 'Unknown path'}: ${error.message}`));
    }
  } // End loop through files

  return summary;
}

/**
 * Print a summary of the import operation.
 */
function printImportSummary(summary, dryRun) {
  const { bold, green, yellow, red, gray, invert } = FORMAT;
  const actionVerb = dryRun ? 'Would be' : 'Were';
  const actionVerbPast = dryRun ? 'Would have been' : 'Were';

  console.log(`
${invert(bold(` Import Summary ${dryRun ? '(Dry Run)' : ''} `))}
${green(`Files ${actionVerb} created:`)}      ${summary.created.length}
${yellow(`Files ${actionVerb} updated (checksum mismatch):`)} ${summary.updated.length}
${gray(`Files ${actionVerb} unchanged (checksum match):`)}    ${summary.unchanged.length}
${red(`Path outside target (skipped):`)} ${summary.skippedOutsideTarget.length}
${red(`Other errors during processing:`)} ${summary.errors.length}
`); // Add trailing newline for spacing

  // Optionally list files, maybe limit list length?
  const MAX_LIST = 15;
  const printList = (label, list, color) => {
      if (list.length > 0) {
          console.log(`${bold(label)}`);
          list.slice(0, MAX_LIST).forEach(f => console.log(`  ${color(f)}`));
          if (list.length > MAX_LIST) {
              console.log(`  ${gray(`...and ${list.length - MAX_LIST} more`)}`);
          }
          console.log(''); // Add space after list
      }
  };

  printList(`${actionVerbPast} Created:`, summary.created, green);
  printList(`${actionVerbPast} Updated (Checksum Mismatch):`, summary.updated, yellow);
  // Don't usually need to list unchanged files
  // printList(`${actionVerbPast} Unchanged (Checksum Match):`, summary.unchanged, gray);
  printList('Paths Outside Target (Skipped):', summary.skippedOutsideTarget, red);

  if (summary.errors.length > 0) {
      console.log(`${bold('Errors During Processing:')}`);
      summary.errors.slice(0, MAX_LIST).forEach(e => console.log(`  ${red(`${e.path}: ${e.error}`)}`));
      if (summary.errors.length > MAX_LIST) {
           console.log(`  ${gray(`...and ${summary.errors.length - MAX_LIST} more errors`)}`);
      }
       console.log(''); // Add space after list
  }
}


////////////////////////////////////////////////////////////////////////////////
// CLI & Main
////////////////////////////////////////////////////////////////////////////////

function printHelp() {
  console.log(`
${FORMAT.bold('codedigest.mjs')} - Generate or import a digest of a directory's text file contents.

${FORMAT.invert(' Modes ')}

  ${FORMAT.bold('Generate Mode (Default):')} Creates a digest file from a directory.
  ${FORMAT.bold('Import Mode:')} Creates/updates files in a directory based on a digest file.
                 Uses checksum comparison between digest content and existing file content.

${FORMAT.invert(' Generate Mode Options ')}

  --path <dir>, -p <dir>           Directory to process (default: current directory ".")
  --output <file>, -o <file>       Output digest file path (default: "digest.txt")
  --ignore <file>, -g <file>       Load ignore patterns from a .gitignore-style file
  --include <file>, -n <file>      Load include patterns from a .gitignore-style file
                                   (If includes are used, only matching files are added)
  --ignore-pattern <ptn>, -i <ptn> Add a single ignore pattern (can use multiple times)
  --include-pattern <ptn>, -I <ptn> Add a single include pattern (can use multiple times)
  --max-size <bytes>, -s <bytes>   Max individual file size (default: ${formatBytes(MAX_FILE_SIZE)})
                                   Supports suffixes KB, MB, GB (e.g., 10MB)
  --max-total-size <bytes>, -t <bytes> Max total size of all included files (default: ${formatBytes(MAX_TOTAL_SIZE_BYTES)})
                                   Supports suffixes KB, MB, GB (e.g., 500MB)
  --max-depth <num>, -d <num>      Max directory recursion depth (default: ${MAX_DIRECTORY_DEPTH})
  --skip-default-ignore, -k        Do not use built-in default ignore patterns
                                   (like node_modules, .git, build, etc.)
  --quiet, -q                      Suppress file add/skip messages (shows summary)
  --ultra-quiet, -uq               Suppress all output except fatal errors

${FORMAT.invert(' Import Mode Options ')}

  --import <file>, -im <file>      REQUIRED: Specify the digest file to import.
  --target <dir>, -tg <dir>        Target directory for import (default: current directory ".")
                                   Directory will be created if it doesn't exist.
  --dry-run, -dr                   Show what would happen without making changes.
  ${FORMAT.gray('--ignore-checksum, -ic')}        ${FORMAT.gray('(Removed) Checksum comparison is now default behavior.')}

${FORMAT.invert(' General Options ')}

  --help, -h                       Display this help message and exit.

${FORMAT.bold('Examples:')}
  ${FORMAT.gray('# Generate digest of src/ folder into my_digest.txt')}
  node codedigest.mjs -p src/ -o my_digest.txt

  ${FORMAT.gray('# Generate, excluding *.log files and limiting total size')}
  node codedigest.mjs -i "*.log" -t 50MB

  ${FORMAT.gray('# Import digest, creating/updating files in ./output_dir')}
  node codedigest.mjs --import my_digest.txt --target ./output_dir

  ${FORMAT.gray('# Dry run import to see changes based on checksum comparison')}
  node codedigest.mjs --import my_digest.txt -tg ./output_dir --dry-run
`);
}

// Helper to parse sizes like "10MB", "5GB"
function parseSizeString(sizeStr) {
    if (!sizeStr) return null;
    const match = String(sizeStr).toUpperCase().match(/^(\d+)\s*(KB|MB|GB|TB)?$/);
    if (!match) {
        const num = parseInt(sizeStr, 10);
        return Number.isFinite(num) && num >= 0 ? num : null;
    }
    const num = parseInt(match[1], 10);
    const unit = match[2];
    if (!Number.isFinite(num) || num < 0) return null;

    switch (unit) {
        case 'KB': return num * 1024;
        case 'MB': return num * 1024 * 1024;
        case 'GB': return num * 1024 * 1024 * 1024;
        case 'TB': return num * 1024 * 1024 * 1024 * 1024;
        default: return num; // Treat as bytes if no unit or unit unknown
    }
}


function validateArgs(args) {
  const errors = [];
  // Validate common args
  if (args.maxSize !== null && args.maxSize <= 0) {
    errors.push(`--max-size must be positive (got ${args.maxSize})`);
  }
  if (args.maxTotalSize !== null && args.maxTotalSize <= 0) {
    errors.push(`--max-total-size must be positive (got ${args.maxTotalSize})`);
  }
  if (args.maxDepth !== null && args.maxDepth < 0) { // Allow 0 depth? Yes, process only root files.
    errors.push(`--max-depth cannot be negative (got ${args.maxDepth})`);
  }

  // Validate generate-specific args if not in import mode
  if (!args.import) {
     if (args.ignoreFile && !existsSync(args.ignoreFile)) {
        errors.push(`Ignore file not found: ${args.ignoreFile}`);
     }
     if (args.includeFile && !existsSync(args.includeFile)) {
        errors.push(`Include file not found: ${args.includeFile}`);
     }
     if (!args.path) {
         errors.push('--path is required for generate mode (or default to ".")');
     } else if (!existsSync(args.path)) {
         errors.push(`Input path not found: ${args.path}`);
     } else if (!lstatSync(args.path).isDirectory()) {
         errors.push(`Input path is not a directory: ${args.path}`);
     }
     if (!args.outputFile) {
         errors.push('--output file path is required (or default to "digest.txt")');
     }
  }
  // Validate import-specific args if in import mode
  else {
      if (!existsSync(args.import)) {
         errors.push(`Import digest file not found: ${args.import}`);
      }
      if (!args.target) {
          errors.push('--target directory is required for import mode (or default to ".")');
      }
      // Target dir existence is checked/created later, but we could check if parent exists?
      // For now, let importDigest handle creation/errors.
  }


  if (errors.length > 0) {
    throw new Error(`Invalid arguments:\n- ${errors.join('\n- ')}`);
  }
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const parsed = {
    // Generate defaults
    path: '.', outputFile: 'digest.txt',
    ignoreFile: null, includeFile: null,
    ignorePatterns: [], includePatterns: [],
    maxSize: MAX_FILE_SIZE, maxTotalSize: MAX_TOTAL_SIZE_BYTES,
    maxDepth: MAX_DIRECTORY_DEPTH,
    skipDefaultIgnore: false,
    // Import defaults
    import: null, target: '.',
    dryRun: false,
    // ignoreChecksum removed
    // General defaults
    quiet: false, ultraQuiet: false,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const nextArg = argv[i + 1]; // Look ahead for value

    switch (arg) {
      // Generate options
      case '--path': case '-p':
        if (!nextArg || nextArg.startsWith('-')) throw new Error(`Option ${arg} requires a value.`);
        parsed.path = argv[++i]; break;
      case '--output': case '-o':
         if (!nextArg || nextArg.startsWith('-')) throw new Error(`Option ${arg} requires a value.`);
        parsed.outputFile = argv[++i]; break;
      case '--ignore': case '-g':
         if (!nextArg || nextArg.startsWith('-')) throw new Error(`Option ${arg} requires a value.`);
        parsed.ignoreFile = argv[++i]; break;
      case '--include': case '-n':
         if (!nextArg || nextArg.startsWith('-')) throw new Error(`Option ${arg} requires a value.`);
        parsed.includeFile = argv[++i]; break;
      case '--ignore-pattern': case '-i':
         if (!nextArg || nextArg.startsWith('-')) throw new Error(`Option ${arg} requires a value.`);
        parsed.ignorePatterns.push(argv[++i]); break;
      case '--include-pattern': case '-I':
         if (!nextArg || nextArg.startsWith('-')) throw new Error(`Option ${arg} requires a value.`);
        parsed.includePatterns.push(argv[++i]); break;
      case '--max-size': case '-s':
         if (!nextArg || nextArg.startsWith('-')) throw new Error(`Option ${arg} requires a value.`);
        parsed.maxSize = parseSizeString(argv[++i]);
        if (parsed.maxSize === null) throw new Error(`Invalid value for ${arg}: ${argv[i]}`);
        break;
      case '--max-total-size': case '-t':
         if (!nextArg || nextArg.startsWith('-')) throw new Error(`Option ${arg} requires a value.`);
        parsed.maxTotalSize = parseSizeString(argv[++i]);
         if (parsed.maxTotalSize === null) throw new Error(`Invalid value for ${arg}: ${argv[i]}`);
        break;
      case '--max-depth': case '-d':
         if (!nextArg || nextArg.startsWith('-')) throw new Error(`Option ${arg} requires a value.`);
        const depth = parseInt(argv[++i], 10);
        if (!Number.isInteger(depth)) throw new Error(`Invalid integer value for ${arg}: ${argv[i]}`);
        parsed.maxDepth = depth;
        break;
      case '--skip-default-ignore': case '-k':
        parsed.skipDefaultIgnore = true; break;

       // Import options
      case '--import': case '-im':
         if (!nextArg || nextArg.startsWith('-')) throw new Error(`Option ${arg} requires a value.`);
        parsed.import = argv[++i]; break;
      case '--target': case '-tg':
         if (!nextArg || nextArg.startsWith('-')) throw new Error(`Option ${arg} requires a value.`);
        parsed.target = argv[++i]; break;
      case '--dry-run': case '-dr':
        parsed.dryRun = true; break;
      case '--ignore-checksum': case '-ic':
        // Removed - flag is ignored now
        console.warn(FORMAT.yellow(`Warning: Option ${arg} is deprecated and ignored. Checksum comparison is now default.`));
        break;

      // General options
      case '--quiet': case '-q':
        parsed.quiet = true; break;
      case '--ultra-quiet': case '-uq':
        // Ultra quiet implies quiet for logging purposes
        parsed.ultraQuiet = true; parsed.quiet = true; break;
      case '--help': case '-h':
        parsed.help = true; break; // Set flag, handle later

      default:
        // Check if it's a positional argument (path or import file maybe?)
        // For simplicity, require flags for now.
        throw new Error(`Unknown option or missing value: ${arg}`);
    }
  }

  // Post-parsing checks / adjustments
  if (parsed.help) {
      printHelp();
      process.exit(0);
  }

  // Can't have both generate and import options conflicting
  // If --import is set, it's import mode. Otherwise generate mode.
  if (parsed.import && (parsed.outputFile !== 'digest.txt' || parsed.path !== '.')) {
      // Warn if generate-specific options were provided alongside --import?
      // For now, let validation catch specific conflicts if needed.
  }


  return parsed;
}


function loadPatternFile(filePath) {
  if (!filePath) return '';
  try {
    return readFileSync(filePath, 'utf-8');
  } catch (err) {
    // Throw a more specific error to be caught by main handler
    throw new Error(`Failed to read pattern file ${filePath}: ${err.message}`);
  }
}

function ensureDirectoryExists(filePath) {
   // Ensures the directory for a given *file* path exists
   const dir = dirname(filePath);
   if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (error) {
         // Throw specific error if directory creation fails
         throw new Error(`Failed to create output directory ${dir}: ${error.message}`);
      }
   }
}

////////////////////////////////////////////////////////////////////////////////
// Main Execution Logic
////////////////////////////////////////////////////////////////////////////////

/** Calculate a short SHA256 checksum for content */
function calculateChecksum(content) {
  // Ensure content is a string or buffer before hashing
  const dataToHash = (typeof content === 'string' || Buffer.isBuffer(content)) ? content : String(content);
  return createHash('sha256').update(dataToHash, 'utf8').digest('hex').substring(0, 12);
}

async function main() {
  let args;
  try {
    args = parseArgs();
    validateArgs(args); // Validate after parsing all args

    // --- Import Mode ---
    if (args.import) {
      const targetDir = args.target; // Target dir validation happens inside importDigest

      if (!args.ultraQuiet) {
        console.log(FORMAT.bold(`--- Starting Digest Import ---`));
        console.log(`Digest file: ${FORMAT.gray(resolve(args.import))}`);
        console.log(`Target dir:  ${FORMAT.gray(resolve(targetDir))}`);
        if (args.dryRun) console.log(FORMAT.yellow('Mode:        Dry Run (no changes will be made)'));
        console.log(FORMAT.white('Compare:     Checksum of digest content vs. disk content'));
        console.log('-----------------------------');
      }

      const summary = importDigest(
        args.import,
        targetDir,
        args.dryRun,
        args.quiet // Pass combined quiet/ultra-quiet status
        // ignoreChecksum removed
      );

      if (!args.ultraQuiet) {
        printImportSummary(summary, args.dryRun);
      }

      // Exit successfully after import
      process.exit(0);
    }

    // --- Generate Mode ---
    const rootPath       = resolve(args.path);
    const outputFilePath = resolve(args.outputFile);

    if (!args.ultraQuiet) {
        console.log(FORMAT.bold(`--- Starting Digest Generation ---`));
        console.log(`Processing: ${FORMAT.gray(rootPath)}`);
        console.log(`Outputting to: ${FORMAT.gray(outputFilePath)}`);
        console.log(`Max file size: ${FORMAT.yellow(formatBytes(args.maxSize))}, Max total size: ${FORMAT.yellow(formatBytes(args.maxTotalSize))}, Max depth: ${FORMAT.yellow(args.maxDepth)}`);
        console.log('--------------------------------');
    }


    // 1) Build final ignoreRules
    let ignoreText = '';
    if (!args.skipDefaultIgnore) {
      ignoreText += Array.from(DEFAULT_IGNORE_PATTERNS).join('\n') + '\n';
    }
    if (args.ignoreFile) {
      ignoreText += loadPatternFile(args.ignoreFile) + '\n';
    }
    if (args.ignorePatterns.length > 0) {
      ignoreText += args.ignorePatterns.join('\n') + '\n';
    }
    const ignoreRules = parseGitignore(ignoreText);

    // 2) Build final includeRules
    let includeText = '';
    if (args.includeFile) {
      includeText += loadPatternFile(args.includeFile) + '\n';
    }
    if (args.includePatterns.length > 0) {
      includeText += args.includePatterns.join('\n') + '\n';
    }
    const includeRules = parseGitignore(includeText);

    // 3) Exclude the output file itself if it's inside the rootPath
    if (outputFilePath.startsWith(rootPath + sep) && outputFilePath !== rootPath) {
      const relOutputPath = relative(rootPath, outputFilePath).split(sep).join('/');
      // Add a specific, anchored rule to ignore the output file
      ignoreRules.push({
        segments: splitIntoSegments(relOutputPath),
        negated: false,
        directoryOnly: false,
        anchored: true, // Anchor it relative to the root
      });
       if (!args.quiet && !args.ultraQuiet) {
           console.log(FORMAT.gray(`(Auto-excluding output file: ${relOutputPath})`));
       }
    }

    // 4) Set up processing options
    const options = {
      ignoreRules,
      includeRules,
      maxFileSize:  args.maxSize,
      maxTotalSize: args.maxTotalSize,
      maxDepth:     args.maxDepth,
      rootPath, // Pass resolved rootPath
      quiet:        args.quiet,
      ultraQuiet:   args.ultraQuiet,
      currentDepth: 0 // Start at depth 0
    };

    // 5) Process directory and collect file info and stats
    const statsObj = createStats(); // Initialize stats object
    const files    = processDirectory(rootPath, options, statsObj); // Start processing

    // 6) Generate Directory Tree String
    const treeResult = { content: '', truncated: false, count: 0 };
    const directoryTree = generateDirectoryTree(
      rootPath, // Start tree from root
      ignoreRules,
      includeRules,
      args.maxDepth, // Use same max depth for tree
      0, '', rootPath, // Initial depth, prefix, root
      treeResult, // Pass result object
      args.ultraQuiet,
      options // Pass options
    );

    // 7) Build File Content Digest String (NO CHECKSUM LINE)
    const digestContent = files
      .sort((a, b) => a.path.localeCompare(b.path)) // Sort files by path for consistent output
      .map((file) => {
        // Removed checksum calculation during generation
        // Ensure content ends with a newline for cleaner separation, unless it's empty
        const contentWithNewline = file.content.length > 0 && !file.content.endsWith('\n')
            ? file.content + '\n'
            : file.content;
        // Output format without the checksum line
        return `### CODEDIGEST_FILE: ${file.path} ###\n${contentWithNewline}### CODEDIGEST_END ###\n\n`;
      }).join('');

    // 8) Generate Final Summary String
    const summary = generateSummary(args.path, statsObj, options, args.outputFile);

    // 9) Write Output File
    ensureDirectoryExists(outputFilePath); // Make sure output directory exists
    writeFileSync(
      outputFilePath,
      `Code Digest for Directory: ${resolve(args.path)}\n` +
      `Generated: ${new Date().toISOString()}\n\n` +
      `Directory Structure (${statsObj.fileCount} included files shown)\n`+
      `==================================================\n`+
      `${directoryTree}\n\n` +
      `Included File Contents (${formatBytes(statsObj.totalSize)})\n`+
      `==================================================\n\n`+
      `${digestContent}`
      // Summary is printed to console, not usually included in the digest itself
    );

    // 10) Print summary to console (if not ultra quiet)
    if (!args.ultraQuiet) {
      console.log('-----------------------------');
      console.log(summary); // Print the generated summary
       console.log(FORMAT.bold(`${FORMAT.green('Digest generation complete.')} Output written to ${FORMAT.gray(outputFilePath)}`));
    }

    if (statsObj.errors.length > 0 && !args.ultraQuiet) {
      console.warn(
        FORMAT.yellow(`\nWarning: ${statsObj.errors.length} errors occurred during processing. See summary or console output for details.`)
      );
    }

  } catch (error) {
    // Catch errors from parsing, validation, file loading, or core processing
    console.error(FORMAT.red(`\nFatal Error: ${error.message}`));
    // Optionally print stack trace for debugging
    // console.error(error.stack);
    process.exit(1); // Exit with error code
  }
}

// Execute main function and catch any unhandled promise rejections
main().catch((error) => {
  console.error(FORMAT.red('\nUnhandled Error:'), error);
  process.exit(1);
});