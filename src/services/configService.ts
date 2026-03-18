import type { MxuConfig } from '@/types/config';
import { defaultConfig } from '@/types/config';
import { loggers } from '@/utils/logger';
import { parseJsonc } from '@/utils/jsonc';
import { joinPath, isTauri, getCacheDir } from '@/utils/paths';

const log = loggers.config;

// 配置文件子目录
const CONFIG_DIR = 'config';
const BACKUP_SUBDIR = 'config_backup';
const BACKUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 生成配置文件名 */
function getConfigFileName(projectName?: string): string {
  return projectName ? `mxu-${projectName}.json` : 'mxu.json';
}

/** 获取配置目录路径（同步版本，用于已知 dataPath 的场景） */
function getConfigDirSync(dataPath: string): string {
  return joinPath(dataPath || '.', CONFIG_DIR);
}

/** 获取配置文件完整路径（同步版本，用于已知 dataPath 的场景） */
function getConfigPathSync(dataPath: string, projectName?: string): string {
  return joinPath(dataPath || '.', CONFIG_DIR, getConfigFileName(projectName));
}

/**
 * 从文件加载配置
 * @param basePath 基础路径（exe 所在目录）
 * @param projectName 项目名称（来自 interface.json 的 name 字段）
 */
export async function loadConfig(basePath: string, projectName?: string): Promise<MxuConfig> {
  if (isTauri()) {
    const configPath = getConfigPathSync(basePath, projectName);

    log.debug('加载配置, 路径:', configPath);

    const { readTextFile, exists } = await import('@tauri-apps/plugin-fs');

    if (await exists(configPath)) {
      try {
        const content = await readTextFile(configPath);
        const config = parseJsonc<MxuConfig>(content, configPath);
        log.info('配置加载成功');
        return config;
      } catch (err) {
        log.warn('读取配置文件失败，使用默认配置:', err);
        return defaultConfig;
      }
    } else {
      log.info('配置文件不存在，使用默认配置');
    }
  } else {
    // 浏览器环境：尝试从 public 目录加载
    try {
      const fileName = getConfigFileName(projectName);
      const fetchPath =
        basePath === '' ? `/${CONFIG_DIR}/${fileName}` : `${basePath}/${CONFIG_DIR}/${fileName}`;
      const response = await fetch(fetchPath);
      if (response.ok) {
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const content = await response.text();
          const config = parseJsonc<MxuConfig>(content, fetchPath);
          log.info('配置加载成功（浏览器环境）');
          return config;
        }
      }
    } catch {
      // 浏览器环境加载失败是正常的
    }
  }

  return defaultConfig;
}

/**
 * 保存配置到文件
 * @param basePath 基础路径（exe 所在目录）
 * @param config 配置对象
 * @param projectName 项目名称（来自 interface.json 的 name 字段）
 */
export async function saveConfig(
  basePath: string,
  config: MxuConfig,
  projectName?: string,
): Promise<boolean> {
  if (!isTauri()) {
    // 浏览器环境不支持保存文件，使用 localStorage 作为后备
    try {
      const storageKey = projectName ? `mxu-config-${projectName}` : 'mxu-config';
      localStorage.setItem(storageKey, JSON.stringify(config));
      log.debug('配置已保存到 localStorage');
      return true;
    } catch {
      return false;
    }
  }

  const configDir = getConfigDirSync(basePath);
  const configPath = getConfigPathSync(basePath, projectName);

  log.debug('保存配置, 路径:', configPath);

  try {
    const { writeTextFile, mkdir, exists, readTextFile } = await import('@tauri-apps/plugin-fs');

    // 确保 config 目录存在
    if (!(await exists(configDir))) {
      log.debug('创建配置目录:', configDir);
      await mkdir(configDir, { recursive: true });
    }

    // 保护：拒绝用空实例覆盖已有的非空配置，避免“配置被清空”
    if (config.instances.length === 0 && (await exists(configPath))) {
      try {
        const existingContent = await readTextFile(configPath);
        const existingConfig = parseJsonc<Partial<MxuConfig>>(existingContent, configPath);
        const existingInstances = Array.isArray(existingConfig.instances)
          ? existingConfig.instances
          : [];
        if (existingInstances.length > 0) {
          log.error('检测到空实例覆盖风险，已拒绝保存:', configPath);
          return false;
        }
      } catch (err) {
        // 读取旧配置失败时，保持保守策略：拒绝覆盖，避免误清空
        log.error('读取现有配置失败，已拒绝覆盖保存:', err);
        return false;
      }
    }

    const content = JSON.stringify(config, null, 2);
    await writeTextFile(configPath, content);
    log.info('配置保存成功');
    return true;
  } catch (err) {
    log.error('保存配置文件失败:', err);
    return false;
  }
}

/**
 * 浏览器环境下从 localStorage 加载配置
 * @param projectName 项目名称（来自 interface.json 的 name 字段）
 */
export function loadConfigFromStorage(projectName?: string): MxuConfig | null {
  if (isTauri()) return null;

  try {
    const storageKey = projectName ? `mxu-config-${projectName}` : 'mxu-config';
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      return JSON.parse(stored) as MxuConfig;
    }
  } catch {
    // ignore
  }
  return null;
}

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function parseTimestampFromFilename(filename: string): Date | null {
  const match = filename.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.json$/);
  if (!match) return null;
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
}

/**
 * 在更新前备份配置文件到 cache/config_backup/，同时清理超过一周的旧备份
 */
export async function backupConfigBeforeUpdate(
  basePath: string,
  projectName?: string,
): Promise<void> {
  if (!isTauri()) return;

  const configPath = getConfigPathSync(basePath, projectName);

  try {
    const { exists, readTextFile, writeTextFile, mkdir, readDir, remove } =
      await import('@tauri-apps/plugin-fs');

    if (!(await exists(configPath))) {
      log.info('配置文件不存在，跳过备份');
      return;
    }

    const cacheDir = await getCacheDir();
    const backupDir = joinPath(cacheDir, BACKUP_SUBDIR);

    if (!(await exists(backupDir))) {
      await mkdir(backupDir, { recursive: true });
    }

    const configFileName = getConfigFileName(projectName);
    const baseName = configFileName.replace(/\.json$/, '');
    const timestamp = formatTimestamp(new Date());
    const backupFileName = `${baseName}-${timestamp}.json`;
    const backupPath = joinPath(backupDir, backupFileName);

    const content = await readTextFile(configPath);
    await writeTextFile(backupPath, content);
    log.info(`配置文件已备份: ${backupPath}`);

    // 清理超过一周的旧备份
    const now = Date.now();
    const entries = await readDir(backupDir);
    for (const entry of entries) {
      if (!entry.name || entry.isDirectory) continue;
      const fileDate = parseTimestampFromFilename(entry.name);
      if (fileDate && now - fileDate.getTime() > BACKUP_MAX_AGE_MS) {
        const oldPath = joinPath(backupDir, entry.name);
        await remove(oldPath).catch((e: unknown) => {
          log.warn(`删除过期备份失败: ${oldPath}`, e);
        });
        log.info(`已删除过期备份: ${entry.name}`);
      }
    }
  } catch (error) {
    log.warn('备份配置文件失败（不影响更新流程）:', error);
  }
}
