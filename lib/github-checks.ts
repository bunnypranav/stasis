const GH_PROXY = 'https://gh-proxy.hackclub.com/gh';
const API_KEY = process.env.GH_PROXY_API_KEY || '';

// --- Shared types ---

export interface CheckResult {
  key: string;
  label: string;
  passed: boolean;
  detail?: string;
}

export interface PreflightCheck {
  key: string;
  label: string;
  status: 'pass' | 'fail' | 'warn' | 'info';
  detail?: string;
  blocking?: boolean;
}

// --- File extension constants ---

export const THREE_D_EXTENSIONS = ['.stl', '.obj', '.3mf', '.iges', '.igs'];
export const THREE_D_SOURCE_EXTENSIONS = ['.f3d', '.step', '.stp', '.fcstd', '.scad', '.blend'];
export const FIRMWARE_EXTENSIONS = ['.ino', '.c', '.cpp', '.h', '.py', '.rs', '.uf2', '.hex', '.bin'];
export const PCB_SOURCE_EXTENSIONS = ['.kicad_pcb', '.kicad_sch', '.kicad_pro', '.brd', '.sch', '.pcbdoc', '.schdoc', '.fzz', '.fzpz'];
export const PCB_FAB_EXTENSIONS = ['.gbr', '.gbl', '.gtl', '.gbs', '.gts', '.gbo', '.gto', '.gko', '.drl', '.zip'];
export const IMAGE_PATTERN = /!\[.*?\]\(.*?\)|<img\s+[^>]*src\s*=|\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg/i;

// --- GitHub API helpers ---

export function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  try {
    const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const u = new URL(normalized);
    if (!u.hostname.includes('github.com')) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
  } catch {
    return null;
  }
}

export async function ghFetch(path: string) {
  const headers: Record<string, string> = {};
  if (API_KEY) headers['X-API-Key'] = API_KEY;
  const res = await fetch(`${GH_PROXY}/${path}`, { headers });
  return res;
}

export async function getRepoTree(owner: string, repo: string): Promise<Array<{ path: string; type: string }> | null> {
  const repoRes = await ghFetch(`repos/${owner}/${repo}`);
  if (!repoRes.ok) return null;
  const repoData = await repoRes.json();
  const branch = repoData.default_branch || 'main';

  const treeRes = await ghFetch(`repos/${owner}/${repo}/git/trees/${branch}?recursive=1`);
  if (!treeRes.ok) return null;
  const treeData = await treeRes.json();
  return treeData.tree || [];
}

export async function getReadmeContent(owner: string, repo: string): Promise<string | null> {
  const res = await ghFetch(`repos/${owner}/${repo}/readme`);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.content && data.encoding === 'base64') {
    return Buffer.from(data.content, 'base64').toString('utf-8');
  }
  return null;
}

// --- Preflight checks for user-facing submission ---

export async function runPreflightChecks(
  githubRepo: string | null,
  tags: string[],
): Promise<{ checks: PreflightCheck[]; canSubmit: boolean }> {
  const checks: PreflightCheck[] = [];

  // Check 1: GitHub repo is valid and accessible
  const parsed = githubRepo ? parseGitHubRepo(githubRepo) : null;
  if (!parsed) {
    checks.push({
      key: 'github_valid',
      label: 'GitHub repo valid',
      status: 'fail',
      detail: githubRepo ? 'Could not parse GitHub URL' : 'No GitHub repo URL set',
      blocking: true,
    });
    return { checks, canSubmit: false };
  }

  const { owner, repo } = parsed;
  const repoRes = await ghFetch(`repos/${owner}/${repo}`);
  if (!repoRes.ok) {
    let detail = `Could not access repo "${owner}/${repo}"`;
    if (repoRes.status === 404) detail = `Repository "${owner}/${repo}" not found - it may be private or the URL is incorrect`;
    else if (repoRes.status === 403) detail = 'Rate limit exceeded - try again in a few minutes';
    else if (repoRes.status >= 500) detail = `GitHub API error (${repoRes.status}) - try again later`;

    checks.push({ key: 'github_valid', label: 'GitHub repo valid', status: 'fail', detail, blocking: true });
    return { checks, canSubmit: false };
  }

  checks.push({ key: 'github_valid', label: 'GitHub repo valid', status: 'pass', detail: `${owner}/${repo}` });

  // Fetch tree and README in parallel
  const [tree, readmeContent] = await Promise.all([
    getRepoTree(owner, repo),
    getReadmeContent(owner, repo),
  ]);

  const filePaths = (tree || []).map((f) => f.path.toLowerCase());

  // Check 2: README exists (blocking)
  const readmeExists = readmeContent !== null;
  checks.push({
    key: 'readme_exists',
    label: 'README exists',
    status: readmeExists ? 'pass' : 'fail',
    detail: readmeExists ? undefined : 'No README found in repository',
    blocking: !readmeExists,
  });

  // Check 3: README has photos (non-blocking error — photos are required but we won't block submit)
  if (readmeExists) {
    const hasPhoto = IMAGE_PATTERN.test(readmeContent!);
    checks.push({
      key: 'readme_has_photo',
      label: 'README has photos',
      status: hasPhoto ? 'pass' : 'fail',
      detail: hasPhoto ? undefined : 'No images found in README - projects are required to include photos of your project',
      blocking: false,
    });
  } else {
    checks.push({
      key: 'readme_has_photo',
      label: 'README has photos',
      status: 'fail',
      detail: 'No README to check',
      blocking: false,
    });
  }

  // Scan for file types
  const found3d = filePaths.filter((p) => THREE_D_EXTENSIONS.some((ext) => p.endsWith(ext)));
  const found3dSource = filePaths.filter((p) => THREE_D_SOURCE_EXTENSIONS.some((ext) => p.endsWith(ext)));
  const foundPcbSource = filePaths.filter((p) => PCB_SOURCE_EXTENSIONS.some((ext) => p.endsWith(ext)));
  const foundPcbFab = filePaths.filter((p) => PCB_FAB_EXTENSIONS.some((ext) => p.endsWith(ext)));

  const hasPcbTag = tags.includes('PCB');
  const hasCadTag = tags.includes('CAD');

  // Check 4: CAD source file warnings
  // Only warn if project is tagged CAD or has 3D model exports (STL/OBJ)
  if (found3d.length > 0 && found3dSource.length === 0) {
    checks.push({
      key: 'cad_source_missing',
      label: '3D source file missing',
      status: 'warn',
      detail: 'Found 3D model files (STL/OBJ) but no source design files (.STEP, .F3D, etc.) - please include your source files',
      blocking: false,
    });
  } else if (hasCadTag && found3dSource.length === 0) {
    checks.push({
      key: 'cad_source_missing',
      label: '3D source file missing',
      status: 'warn',
      detail: 'Project includes custom CAD but no source design files (.STEP, .F3D, etc.) were found - please include your source files',
      blocking: false,
    });
  } else if (found3dSource.length > 0) {
    checks.push({
      key: 'cad_source_missing',
      label: '3D source file',
      status: 'pass',
      detail: found3dSource.slice(0, 3).join(', '),
    });
  }

  // Check 5: PCB source file warnings
  // Only warn if project is tagged PCB or has gerber/fab files
  if (foundPcbFab.length > 0 && foundPcbSource.length === 0) {
    checks.push({
      key: 'pcb_source_missing',
      label: 'PCB source file missing',
      status: 'warn',
      detail: 'Found fabrication/Gerber files but no PCB source files (.kicad_pcb, .brd, etc.) - please include your source files',
      blocking: false,
    });
  } else if (hasPcbTag && foundPcbSource.length === 0) {
    checks.push({
      key: 'pcb_source_missing',
      label: 'PCB source file missing',
      status: 'warn',
      detail: 'Project includes custom PCB but no source files (.kicad_pcb, .brd, etc.) were found - please include your source files',
      blocking: false,
    });
  } else if (foundPcbSource.length > 0) {
    checks.push({
      key: 'pcb_source_missing',
      label: 'PCB source file',
      status: 'pass',
      detail: foundPcbSource.slice(0, 3).join(', '),
    });
  }

  // Check 6: Auto-detect suggestions
  if (!hasPcbTag && (foundPcbSource.length > 0 || foundPcbFab.length > 0)) {
    checks.push({
      key: 'suggest_pcb_tag',
      label: 'PCB files detected',
      status: 'info',
      detail: 'We found PCB files in your repo - consider tagging your project as Custom PCB',
      blocking: false,
    });
  }
  if (!hasCadTag && (found3d.length > 0 || found3dSource.length > 0)) {
    checks.push({
      key: 'suggest_cad_tag',
      label: 'CAD files detected',
      status: 'info',
      detail: 'We found 3D/CAD files in your repo - consider tagging your project as Custom CAD',
      blocking: false,
    });
  }

  const canSubmit = !checks.some((c) => c.blocking && c.status === 'fail');
  return { checks, canSubmit };
}
