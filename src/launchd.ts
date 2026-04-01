import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

const ASSISTANT_NAME_ENTRY =
  /\n\s*<key>ASSISTANT_NAME<\/key>\n\s*<string>[^<]*<\/string>/;

export function stripAssistantNameFromLaunchdPlist(content: string): string {
  return content.replace(ASSISTANT_NAME_ENTRY, '');
}

export function installedLaunchdPlistHasAssistantName(
  homeDir = os.homedir(),
): boolean {
  if (process.platform !== 'darwin') {
    return false;
  }

  const plistPath = path.join(
    homeDir,
    'Library',
    'LaunchAgents',
    'com.nanoclaw.plist',
  );
  if (!fs.existsSync(plistPath)) {
    return false;
  }

  return ASSISTANT_NAME_ENTRY.test(fs.readFileSync(plistPath, 'utf-8'));
}

export function sanitizeInstalledLaunchdPlist(homeDir = os.homedir()): boolean {
  if (!installedLaunchdPlistHasAssistantName(homeDir)) {
    return false;
  }

  const plistPath = path.join(
    homeDir,
    'Library',
    'LaunchAgents',
    'com.nanoclaw.plist',
  );
  const content = fs.readFileSync(plistPath, 'utf-8');
  const updated = stripAssistantNameFromLaunchdPlist(content);
  if (updated === content) {
    return false;
  }

  fs.writeFileSync(plistPath, updated);
  logger.info({ plistPath }, 'Removed ASSISTANT_NAME from installed launchd plist');
  return true;
}
