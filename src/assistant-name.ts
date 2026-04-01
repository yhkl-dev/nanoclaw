import fs from 'fs';

export const DEFAULT_ASSISTANT_NAME = 'Henry';
export const LEGACY_ASSISTANT_NAMES = ['Andy'];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getAcceptedAssistantNames(currentName: string): string[] {
  return Array.from(
    new Set([currentName, DEFAULT_ASSISTANT_NAME, ...LEGACY_ASSISTANT_NAMES]),
  );
}

export function replaceAssistantIdentityInClaudeMd(
  content: string,
  assistantName: string,
): string {
  let next = content;

  for (const name of getAcceptedAssistantNames(assistantName)) {
    if (name === assistantName) continue;

    next = next.replace(
      new RegExp(`^# ${escapeRegex(name)}$`, 'm'),
      `# ${assistantName}`,
    );
    next = next.replace(
      new RegExp(`You are ${escapeRegex(name)}`, 'g'),
      `You are ${assistantName}`,
    );
  }

  return next;
}

export function updateClaudeMdAssistantIdentity(
  filePath: string,
  assistantName: string,
): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const updated = replaceAssistantIdentityInClaudeMd(content, assistantName);

  if (updated === content) {
    return false;
  }

  fs.writeFileSync(filePath, updated);
  return true;
}

export function updateAssistantNameEnvFile(
  filePath: string,
  assistantName: string,
  options: {
    createIfMissing?: boolean;
    appendIfMissing?: boolean;
  } = {},
): boolean {
  const createIfMissing =
    options.createIfMissing ?? assistantName !== DEFAULT_ASSISTANT_NAME;
  const appendIfMissing =
    options.appendIfMissing ?? assistantName !== DEFAULT_ASSISTANT_NAME;

  if (!fs.existsSync(filePath)) {
    if (!createIfMissing) {
      return false;
    }

    fs.writeFileSync(filePath, `ASSISTANT_NAME="${assistantName}"\n`);
    return true;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  if (content.includes('ASSISTANT_NAME=')) {
    const updated = content.replace(
      /^ASSISTANT_NAME=.*$/m,
      `ASSISTANT_NAME="${assistantName}"`,
    );
    if (updated === content) {
      return false;
    }
    fs.writeFileSync(filePath, updated);
    return true;
  }

  if (!appendIfMissing) {
    return false;
  }

  fs.writeFileSync(filePath, `${content}\nASSISTANT_NAME="${assistantName}"`);
  return true;
}
