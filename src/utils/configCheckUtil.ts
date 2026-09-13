import { invoke } from '@tauri-apps/api/core'
import { join } from '@tauri-apps/api/path'
import { error, warn } from '@tauri-apps/plugin-log'
import { getConfigDir, getCoreDir } from './fileUtil'

export interface ConfigCheckResult {
  valid: boolean
  message?: string
}

/**
 * 调用 easytier-core --check-config 校验配置文件。
 * 核心（v2.6.4 实测）对配置中的未知自定义键（如 config_exit_nodes_route）是宽容的，
 * 仅语法错误或必填项缺失时退出码非 0。
 * @param configFileName 配置文件名（如 server.toml）
 * @returns valid 为 true 表示校验通过
 */
export async function checkConfigFile(configFileName: string): Promise<ConfigCheckResult> {
  try {
    const configPath = await join(await getConfigDir(), configFileName)
    const program = await getCoreDir()
    const res = await invoke<{ code: number; stdout: string; stderr: string }>('check_config', {
      program,
      configPath
    })
    if (res.code === 0) {
      return { valid: true }
    }
    const detail = (res.stderr || res.stdout || '').trim()
    warn(`配置校验失败(${configFileName}): ${detail || 'exit ' + res.code}`)
    return {
      valid: false,
      message: detail || `easytier-core --check-config 退出码 ${res.code}`
    }
  } catch (e: any) {
    error(`配置校验执行异常:${JSON.stringify(e)}`)
    return { valid: false, message: String(e) }
  }
}
