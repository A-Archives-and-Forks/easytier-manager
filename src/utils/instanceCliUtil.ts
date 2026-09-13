import { CONFIG_PATH } from '@/constants/easytier'
import { error, info } from '@tauri-apps/plugin-log'
import { readFileContent, writeFileContent } from './fileUtil'
import { runEasyTierCli } from './shellUtil'
import * as toml from 'smol-toml'

export interface CliResult {
  ok: boolean
  output: string
  error?: string
  data?: any
}

/**
 * 执行 easytier-cli 并统一容错：
 * runEasyTierCli 成功时返回字符串，失败时返回 { code, msg } 对象或抛异常。
 */
export async function cliRun(args: string[]): Promise<CliResult> {
  try {
    const res: any = await runEasyTierCli(args)
    if (res && typeof res === 'object') {
      return { ok: false, output: '', error: res.msg || JSON.stringify(res) }
    }
    return { ok: true, output: String(res ?? '') }
  } catch (e: any) {
    return { ok: false, output: '', error: String(e?.message || e) }
  }
}

/** 执行 easytier-cli 并尝试 JSON 解析；解析失败时 data 为空，调用方可回退展示 output 文本 */
export async function cliJson(args: string[]): Promise<CliResult> {
  const res = await cliRun(args)
  if (!res.ok) return res
  try {
    const data = JSON.parse(res.output)
    return { ...res, data }
  } catch {
    return res
  }
}

/**
 * 读取并修改实例对应的 TOML 配置文件（手动回写）。
 * 只在 mutate 中修改目标字段，其余内容保持原样。
 * @param configFileName 配置文件名（如 server.toml）
 * @param mutate 就地修改解析后的配置对象
 * @returns 是否成功
 */
export async function updateTomlConfig(
  configFileName: string,
  mutate: (config: any) => void
): Promise<boolean> {
  try {
    const content = (await readFileContent(CONFIG_PATH + '/' + configFileName)) as string
    const config = toml.parse(content) as any
    mutate(config)
    await writeFileContent(CONFIG_PATH + '/' + configFileName, toml.stringify(config))
    info(`配置回写成功：${configFileName}`)
    return true
  } catch (e: any) {
    error(`配置回写失败(${configFileName}):${JSON.stringify(e)}`)
    return false
  }
}

/** "80,443,8000-9000" -> 数组（去空项） */
export const splitPortList = (value: string): string[] =>
  (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

/** 数组 -> "80,443,8000-9000" */
export const joinPortList = (value: any): string =>
  Array.isArray(value) ? value.join(',') : String(value ?? '')
