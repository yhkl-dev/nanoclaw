import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { GROUPS_DIR, PROJECT_ROOT } from './config.js';
import { logger } from './logger.js';

export interface EditProposal {
  id: string;
  filePath: string;
  description: string;
  originalContent: string;
  newContent: string;
  diff: string;
  createdAt: string;
}

interface PendingEditsStore {
  proposals: EditProposal[];
  updatedAt: string;
}

const PENDING_EDITS_FILE = '.pending-edits.json';

function getPendingEditsPath(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder, PENDING_EDITS_FILE);
}

export function loadPendingEdits(groupFolder: string): EditProposal[] {
  const p = getPendingEditsPath(groupFolder);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as PendingEditsStore;
    return raw.proposals ?? [];
  } catch {
    return [];
  }
}

function savePendingEdits(
  groupFolder: string,
  proposals: EditProposal[],
): void {
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });
  const store: PendingEditsStore = {
    proposals,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    getPendingEditsPath(groupFolder),
    JSON.stringify(store, null, 2) + '\n',
  );
}

export function clearPendingEdits(groupFolder: string): void {
  const p = getPendingEditsPath(groupFolder);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function generateUnifiedDiff(
  originalContent: string,
  newContent: string,
  fileName: string,
): string {
  const tmpDir = os.tmpdir();
  const ts = Date.now();
  const origFile = path.join(tmpDir, `nc-orig-${ts}`);
  const newFile = path.join(tmpDir, `nc-new-${ts}`);
  try {
    fs.writeFileSync(origFile, originalContent, 'utf-8');
    fs.writeFileSync(newFile, newContent, 'utf-8');
    try {
      return execFileSync(
        'diff',
        [
          '-u',
          `--label=a/${fileName}`,
          `--label=b/${fileName}`,
          origFile,
          newFile,
        ],
        { encoding: 'utf-8', timeout: 5_000 },
      );
    } catch (e: unknown) {
      // diff exits code 1 when files differ — not an error
      if (e && typeof e === 'object' && 'stdout' in e) {
        return (e as { stdout: string }).stdout;
      }
      throw e;
    }
  } finally {
    try {
      fs.unlinkSync(origFile);
    } catch {}
    try {
      fs.unlinkSync(newFile);
    } catch {}
  }
}

/**
 * Record a proposed code edit and return the unified diff for display.
 * If a proposal for the same file already exists, it is replaced.
 */
export function recordPendingEdit(
  groupFolder: string,
  filePath: string,
  description: string,
  newContent: string,
): { id: string; diff: string; isNewFile: boolean } {
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.join(PROJECT_ROOT, filePath);

  const originalContent = fs.existsSync(resolved)
    ? fs.readFileSync(resolved, 'utf-8')
    : '';

  const isNewFile = originalContent === '';
  const fileName = path.relative(PROJECT_ROOT, resolved);
  const diff = isNewFile
    ? `(new file) ${fileName}\n${newContent.slice(0, 3000)}`
    : generateUnifiedDiff(originalContent, newContent, fileName);

  const proposal: EditProposal = {
    id: `edit-${Date.now()}`,
    filePath: resolved,
    description,
    originalContent,
    newContent,
    diff,
    createdAt: new Date().toISOString(),
  };

  const existing = loadPendingEdits(groupFolder);
  // Replace existing proposal for the same file; latest wins.
  const filtered = existing.filter((p) => p.filePath !== resolved);
  savePendingEdits(groupFolder, [...filtered, proposal]);

  logger.info(
    { group: groupFolder, file: fileName, id: proposal.id, isNewFile },
    '[pending-edits] recorded pending edit',
  );

  return { id: proposal.id, diff, isNewFile };
}

export interface ApplyResult {
  applied: string[];
  skipped: string[];
  buildOutput: string;
  buildSuccess: boolean;
}

/**
 * Apply all pending edits, run tsc --noEmit to verify compilation.
 * On build failure, reverts all applied files and reports the error.
 */
export async function applyPendingEdits(
  groupFolder: string,
): Promise<ApplyResult> {
  const proposals = loadPendingEdits(groupFolder);
  if (proposals.length === 0) {
    return { applied: [], skipped: [], buildOutput: '', buildSuccess: true };
  }

  const applied: string[] = [];
  const skipped: string[] = [];
  const backups = new Map<string, string>();

  for (const proposal of proposals) {
    const relPath = path.relative(PROJECT_ROOT, proposal.filePath);
    backups.set(proposal.filePath, proposal.originalContent);
    try {
      fs.mkdirSync(path.dirname(proposal.filePath), { recursive: true });
      fs.writeFileSync(proposal.filePath, proposal.newContent, 'utf-8');
      applied.push(relPath);
      logger.info({ file: relPath }, '[pending-edits] applied edit');
    } catch (err) {
      skipped.push(relPath);
      logger.warn(
        { file: relPath, err },
        '[pending-edits] failed to write file',
      );
    }
  }

  // Run TypeScript type-check (no emit).
  let buildOutput = '';
  let buildSuccess = false;
  try {
    const out = execFileSync('npm', ['run', 'typecheck'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 90_000,
    });
    buildOutput = (out ?? '').slice(0, 2000);
    buildSuccess = true;
    logger.info({ group: groupFolder }, '[pending-edits] typecheck passed');
  } catch (e: unknown) {
    if (e && typeof e === 'object') {
      buildOutput = (
        ((e as Record<string, unknown>).stderr as string) ??
        ((e as Record<string, unknown>).stdout as string) ??
        ''
      ).slice(0, 3000);
    }
    buildSuccess = false;
    logger.warn(
      { group: groupFolder },
      '[pending-edits] typecheck failed — reverting edits',
    );
    // Revert all applied files.
    for (const filePath of applied) {
      const abs = path.join(PROJECT_ROOT, filePath);
      const original = backups.get(abs) ?? '';
      if (original) {
        fs.writeFileSync(abs, original, 'utf-8');
      } else {
        try {
          fs.unlinkSync(abs);
        } catch {}
      }
    }
  }

  clearPendingEdits(groupFolder);
  return { applied, skipped, buildOutput, buildSuccess };
}

/**
 * Format pending edits as a human-readable summary for the user.
 */
export function formatPendingEditsSummary(proposals: EditProposal[]): string {
  if (proposals.length === 0) return '';
  const files = proposals
    .map(
      (p) => `• ${path.relative(PROJECT_ROOT, p.filePath)}: ${p.description}`,
    )
    .join('\n');
  return (
    `\n---\n📝 待审核修改 (${proposals.length} 个文件):\n${files}\n\n` +
    `回复 **确认修改** 应用并验证编译，或 **取消修改** 放弃。`
  );
}
