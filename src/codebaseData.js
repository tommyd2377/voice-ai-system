import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT_REALPATH = await fs.realpath(REPO_ROOT);

const MAX_FILE_BYTES = 200_000;
const MAX_SNIPPET_LINES = 120;
const DEFAULT_SNIPPET_LINES = 80;
const MAX_SEARCH_RESULTS = 20;

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.turbo',
  '.vercel',
  'coverage',
  'dist',
  'build',
  'node_modules',
]);

const SKIPPED_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

const ALLOWED_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.sql',
  '.ts',
  '.tsx',
  '.txt',
  '.yml',
  '.yaml',
]);

const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.env($|[./])/i,
  /(^|\/).*secret.*$/i,
  /(^|\/).*service.*account.*$/i,
  /(^|\/).*credential.*$/i,
  /(^|\/).*private.*key.*$/i,
  /(^|\/).*token.*$/i,
  /(^|\/).*\.pem$/i,
  /(^|\/).*\.p12$/i,
  /(^|\/).*\.key$/i,
];

const clampInteger = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

const toPosixPath = (filePath) => filePath.split(path.sep).join('/');

const isSensitivePath = (relativePath) => {
  const normalized = toPosixPath(relativePath);
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
};

const isAllowedFile = async (relativePath, absolutePath) => {
  if (SKIPPED_FILES.has(path.basename(relativePath))) return false;
  if (isSensitivePath(relativePath)) return false;
  if (!ALLOWED_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) return false;

  const stat = await fs.stat(absolutePath);
  return stat.isFile() && stat.size <= MAX_FILE_BYTES;
};

const getSafePath = async (filePath) => {
  const requestedPath = String(filePath || '').trim();
  if (!requestedPath || path.isAbsolute(requestedPath)) {
    throw new Error('filePath must be a relative path inside the repository.');
  }

  const normalizedPath = path.normalize(requestedPath);
  if (normalizedPath.startsWith('..') || normalizedPath.includes(`${path.sep}..${path.sep}`)) {
    throw new Error('filePath must stay inside the repository.');
  }

  const absolutePath = path.resolve(REPO_ROOT, normalizedPath);
  const realPath = await fs.realpath(absolutePath);

  if (realPath !== REPO_ROOT_REALPATH && !realPath.startsWith(`${REPO_ROOT_REALPATH}${path.sep}`)) {
    throw new Error('filePath must stay inside the repository.');
  }

  const relativePath = toPosixPath(path.relative(REPO_ROOT_REALPATH, realPath));
  if (!(await isAllowedFile(relativePath, realPath))) {
    throw new Error('That file is not available through the read-only codebase tool.');
  }

  return { absolutePath: realPath, relativePath };
};

const readSafeTextFile = async (relativePath) => {
  const { absolutePath, relativePath: safeRelativePath } = await getSafePath(relativePath);
  const contents = await fs.readFile(absolutePath, 'utf8');
  return { contents, relativePath: safeRelativePath };
};

const walkSafeFiles = async (directory = REPO_ROOT, prefix = '') => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name) && !isSensitivePath(relativePath)) {
        files.push(...(await walkSafeFiles(absolutePath, relativePath)));
      }
      continue;
    }

    if (entry.isFile() && (await isAllowedFile(relativePath, absolutePath))) {
      const stat = await fs.stat(absolutePath);
      files.push({
        path: toPosixPath(relativePath),
        bytes: stat.size,
      });
    }
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
};

const git = async (args) => {
  if (!existsSync(path.join(REPO_ROOT, '.git'))) return null;

  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: REPO_ROOT,
      timeout: 1000,
      maxBuffer: 50_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

const deploymentValue = (value) => {
  const text = String(value || '').trim();
  return text || null;
};

const getDeploymentGitMetadata = () => {
  const commit = deploymentValue(process.env.RAILWAY_GIT_COMMIT_SHA);
  const branch = deploymentValue(process.env.RAILWAY_GIT_BRANCH);

  return {
    branch,
    commit,
    shortCommit: commit ? commit.slice(0, 7) : null,
    source: commit || branch ? 'deployment_env' : 'local_filesystem',
  };
};

const getGitMetadata = async () => {
  const [commit, shortCommit, branch] = await Promise.all([
    git(['rev-parse', 'HEAD']),
    git(['rev-parse', '--short', 'HEAD']),
    git(['branch', '--show-current']),
  ]);
  const deploymentMetadata = getDeploymentGitMetadata();

  return {
    branch: branch || deploymentMetadata.branch,
    commit: commit || deploymentMetadata.commit,
    shortCommit: shortCommit || deploymentMetadata.shortCommit,
    source: commit ? 'local_git_checkout' : deploymentMetadata.source,
  };
};

export async function getCodebaseOverview(input = {}) {
  const maxFiles = clampInteger(input?.maxFiles, 50, 1, 100);
  const files = await walkSafeFiles();

  return {
    ok: true,
    repository: path.basename(REPO_ROOT),
    git: await getGitMetadata(),
    fileCount: files.length,
    files: files.slice(0, maxFiles),
    truncated: files.length > maxFiles,
    note: 'Read-only view of the currently running deployed filesystem. Sensitive files and large generated files are excluded.',
  };
}

export async function searchCodebase(input = {}) {
  const query = String(input?.query || '').trim();
  const limit = clampInteger(input?.limit, 10, 1, MAX_SEARCH_RESULTS);

  if (query.length < 2) {
    return {
      ok: false,
      reason: 'query_too_short',
      message: 'Search query must be at least 2 characters.',
    };
  }

  const queryLower = query.toLowerCase();
  const files = await walkSafeFiles();
  const matches = [];

  for (const file of files) {
    if (matches.length >= limit) break;

    const { contents, relativePath } = await readSafeTextFile(file.path);
    const lines = contents.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].toLowerCase().includes(queryLower)) continue;

      matches.push({
        path: relativePath,
        line: index + 1,
        preview: lines[index].trim().slice(0, 220),
      });

      if (matches.length >= limit) break;
    }
  }

  return {
    ok: true,
    query,
    git: await getGitMetadata(),
    matches,
    truncated: matches.length >= limit,
  };
}

export async function readCodeSnippet(input = {}) {
  const { contents, relativePath } = await readSafeTextFile(input?.filePath);
  const lines = contents.split(/\r?\n/);
  const startLine = clampInteger(input?.startLine, 1, 1, lines.length || 1);
  const fallbackEndLine = Math.min(startLine + DEFAULT_SNIPPET_LINES - 1, lines.length);
  const requestedEndLine = clampInteger(input?.endLine, fallbackEndLine, startLine, lines.length || 1);
  const endLine = Math.min(requestedEndLine, startLine + MAX_SNIPPET_LINES - 1);
  const snippet = lines
    .slice(startLine - 1, endLine)
    .map((line, index) => ({
      line: startLine + index,
      text: line,
    }));

  return {
    ok: true,
    path: relativePath,
    git: await getGitMetadata(),
    startLine,
    endLine,
    totalLines: lines.length,
    truncated: requestedEndLine > endLine,
    snippet,
  };
}
