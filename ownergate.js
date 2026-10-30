/**
 * 管理员门禁 —— 「能翻全宿主旧对话」的能力只给管理员。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么需要这个文件（而不是在工具里判断发言者）
 *
 * 工具自己**判断不了谁是发言人**，两条路都堵死了：
 *   · `@deepseek-ai/dsh-tools` 的 `createExecution()` 只往 exec 上放
 *     token / callId / rootCallId / name / signal / agent / parent / arguments ——
 *     **没有 sender、没有 userId、没有 message**（全库 grep 不到）。
 *     `exec.agent.session.header` 只有 id / createdAt / cwd / isSeeded / delegationDepth /
 *     agentPreset，同样没有身份。
 *   · 而 QQ 会话是**一个群一个会话**：同一个群的所有成员共用一个 sessionId，
 *     会话层面根本无法区分「这条是管理员发的还是某个群友发的」。
 *
 * 身份只在 qq-bridge 的 `handleIncoming` 里：
 *     const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');
 * 它每一轮投递 prompt 前把结果写进 `$DSH_HOME/dsh-mind-qq-gate.json`，我们按 sessionId 读。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 判定的三个状态（重要：方向不能搞反）
 *
 *   not-qq    → 放行。门禁文件不存在、或这个会话既没有记录、cwd 也不在桥接登记的工作区里
 *               ⇒ 这是**桌面会话**（管理员自己的窗口）。缺记录就拒绝会把正常使用挡掉。
 *   owner     → 放行。
 *   not-owner / no-record / stale → 拒绝。
 *
 * `no-record` 是「确认是 QQ 会话（cwd 命中），但没有这个 sessionId 的记录」——
 * 说明桥接没写成功或刚换了会话，宁严不松。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么是文件而不是共享内存
 *
 * 桥接与 DSH 宿主是**两个进程**。共享内存要开 socket，而这里的数据是
 * 「最近一轮谁说的」这种几十字节、每条消息写一次的东西 —— 原子写一个 JSON 就够，
 * 而且桥接挂了文件还在（有 TTL 兜底，过期自动失效，不会留下永久放行）。
 */

import { readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import os from 'node:os'

/** 记录的有效期：超过就当作没记录（桥接可能已经停了）。 */
export const GATE_TTL_MS = 30 * 60 * 1000

/** 门禁文件路径 —— 桥接与插件必须用同一份规则解析 DSH_HOME。 */
export function gateFile() {
  const home = process.env.DSH_HOME || join(os.homedir(), '.dsh')
  return join(home, 'dsh-mind-qq-gate.json')
}

/** 读门禁文件；坏了/没有都当 null（不能让一个损坏的 JSON 把工具整个卡死）。 */
export function loadGate(file) {
  try {
    const raw = JSON.parse(readFileSync(file || gateFile(), 'utf8'))
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}

/**
 * 这个会话现在能不能用跨会话能力。
 *
 * @param sessionId 当前会话 id（从 exec.agent.session.header.id 取）
 * @param cwd       当前工作目录（从 exec.agent.session.header.cwd 取）
 * @param gate      可选：直接传已读好的门禁对象（测试用）
 * @returns {{ allowed: boolean, reason: 'not-qq'|'owner'|'not-owner'|'no-record'|'stale', key: string }}
 */
export function crossSessionGate(sessionId, cwd, gate) {
  const g = gate === undefined ? loadGate() : gate
  if (!g) return { allowed: true, reason: 'not-qq', key: '' }
  const workspaces = Array.isArray(g.workspaces) ? g.workspaces.filter(Boolean).map(String) : []
  const sessions = (g.sessions && typeof g.sessions === 'object' && g.sessions) || {}
  const rec = sessionId ? sessions[sessionId] : null
  const where = String(cwd ?? '')

  // 只有能确认「这是 QQ 会话」才进入门禁逻辑。
  //
  // ⚠️ 必须**统一小写**再比：Windows 路径不区分大小写，而 startsWith 区分。
  //    `E:\QQ-Bridge\workspace` 和 `E:\qq-bridge\workspace` 是同一个目录，
  //    大小写一歪就会判成「不是 QQ 会话」→ 直接放行 → 门禁形同不存在。
  const lower = (s) => s.toLowerCase()
  const inWorkspace = !!where && workspaces.some((w) => {
    const base = lower(w)
    const dir = lower(where)
    return dir === base || dir.startsWith(base.endsWith(sep) ? base : base + sep) || dir.startsWith(base + '/')
  })
  const isQq = !!rec || inWorkspace
  if (!isQq) return { allowed: true, reason: 'not-qq', key: '' }

  if (!rec || typeof rec !== 'object') return { allowed: false, reason: 'no-record', key: '' }
  const at = Number(rec.at)
  if (!Number.isFinite(at) || Date.now() - at > GATE_TTL_MS) {
    return { allowed: false, reason: 'stale', key: String(rec.key || '') }
  }
  if (rec.owner !== true) return { allowed: false, reason: 'not-owner', key: String(rec.key || '') }
  return { allowed: true, reason: 'owner', key: String(rec.key || '') }
}

/** 拒绝时给模型看的文案：必须让模型明白这是**权限**问题，不是「没找到」。 */
export function gateDeniedMessage(reason, key) {
  const where = key ? `（会话 ${key}）` : ''
  if (reason === 'no-record') {
    return `memory 只对管理员开放${where}：这一轮没有记录到管理员身份，已拒绝。`
      + '\n如果确实是管理员在问，让他直接说一句，下一轮会带上身份；群里其他成员不能翻旧对话。'
  }
  if (reason === 'stale') {
    return `memory 只对管理员开放${where}：最近一次发言人身份记录已过期（超过 30 分钟），已拒绝。`
      + '\n管理员再说一句就会刷新记录。'
  }
  return `memory 只对管理员开放${where}：这一轮发言的不是管理员，已拒绝。`
    + '\n你可以正常聊天，但不能翻查硬盘上的历史对话，也不要复述别的会话里的内容。'
}
