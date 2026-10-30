import { useState } from 'react'
import { blacklistHit } from '../../shared/automation'
import { Dot, Group, Row, Switch, type PageProps } from './settings-ui'

export function RulesSettings({ snapshot, busy, update, navigate }: PageProps) {
  const auto = snapshot.preferences.automation
  const remoteOn = snapshot.remote.enabled
  const [keyword, setKeyword] = useState('')
  const [probe, setProbe] = useState('git push origin main')
  const duplicate = !!keyword.trim() && auto.blacklist.some(entry => entry.toLowerCase() === keyword.trim().toLowerCase())
  // Saving goes through preference normalization: trimming, line splitting and case-insensitive dedupe.
  const add = (): void => {
    if (!keyword.trim() || duplicate) return
    update({ automation: { blacklist: [...auto.blacklist, keyword] } })
    setKeyword('')
  }
  const remove = (entry: string): void => update({ automation: { blacklist: auto.blacklist.filter(item => item !== entry) } })
  const hit = probe.trim() ? blacklistHit(auto.blacklist, probe) : undefined
  const elsewhere = remoteOn ? '进入远程待办' : '留在原 Agent 中由你处理'
  const verdict = !probe.trim() ? undefined : !auto.enabled ? { tone: 'off' as const, title: '交给你处理', text: `自动处理已暂停，请求${elsewhere}。` }
    : hit ? { tone: 'warn' as const, title: '转交处理', text: `命中「${hit}」，请求${elsewhere}，选择题也不会自动回答。` }
    : auto.approvePermissions ? { tone: 'ok' as const, title: '自动批准', text: '未命中黑名单。如果是权限请求，只批准这一次。' }
    : { tone: 'off' as const, title: '交给你处理', text: `未命中黑名单，但「自动批准权限请求」已关闭，请求${elsewhere}。` }
  return <>
    <section className="settings-group rules-master settings-master" data-enabled={auto.enabled} aria-labelledby="automation-switch-label">
      <div className="settings-card">
        <Switch id="automation-switch" title="自动处理" checked={auto.enabled} disabled={busy} onChange={enabled => update({ automation: { enabled } })}
          description={remoteOn ? auto.enabled ? 'Claude Code 和 Codex 先按下方规则处理，无法自动处理的请求交给远程接管。' : '已暂停，接管的请求由你在灵动岛或远程渠道处理。'
            : auto.enabled ? 'Claude Code 和 Codex 的请求先按下方规则处理。' : '已暂停，所有请求由你在原 Agent 中处理。'} />
        <div className="settings-master-foot"><Dot tone={auto.enabled ? 'ok' : 'off'} />
          <span className="rules-flow" aria-label="处理顺序">请求 <i>黑名单</i>→<i>规则</i>→<i>{remoteOn ? '远程待办' : '原 Agent'}</i></span>
          <button type="button" onClick={() => navigate(remoteOn ? 'remote' : 'home')}>{remoteOn ? '管理远程接管' : '查看 Agent 接入'} <span aria-hidden="true">→</span></button></div>
      </div>
      {remoteOn && <p className="settings-group-foot">远程接管同时开启时，由远程入口统一回传，独立的自动审批通道暂停响应，避免两个通道重复回复。</p>}
    </section>
    <Group title="规则" footer="批准和回答只通过原生交互通道回传，不代表工具执行成功。读取日志本身不能批准任何请求。">
      <Switch title="自动批准权限请求" description="命令执行、文件修改等工具权限。只批准当前这一次。" checked={auto.approvePermissions} disabled={busy}
        onChange={approvePermissions => update({ automation: { approvePermissions } })} />
      <Switch title="自动回答选择题" description="选择标注「推荐」或「Recommended」的选项并提交。" checked={auto.answerQuestions} disabled={busy}
        onChange={answerQuestions => update({ automation: { answerQuestions } })} />
      <Row title="没有推荐选项时" description="仅适用于有明确选项的问题。自由输入和密码类问题始终交给你。" htmlFor="question-fallback">
        <select id="question-fallback" value={auto.fallback} disabled={busy || !auto.answerQuestions}
          onChange={event => update({ automation: { fallback: event.target.value as 'manual' | 'first' } })}><option value="manual">保留手动回答</option><option value="first">选择第一个选项</option></select>
      </Row>
    </Group>
    <Group title="黑名单" titleId="blacklist-title" aside="命中时交给你处理"
      footer="忽略大小写，按包含匹配工具名、命令、路径、说明和问题内容。只匹配 Agent 提供的内容；留空表示不设置黑名单。">
      <div className="blacklist-tags" aria-label="黑名单关键词">
        {auto.blacklist.length ? auto.blacklist.map(entry => <span key={entry} className="blacklist-tag" data-keyword={entry}>{entry}
          <button type="button" aria-label={`移除关键词 ${entry}`} disabled={busy} onClick={() => remove(entry)}>×</button></span>)
          : <span className="setting-hint">还没有关键词。</span>}
      </div>
      <form className="setting-field" onSubmit={event => { event.preventDefault(); add() }}>
        <label htmlFor="blacklist-new">添加关键词</label>
        <div className="connection-form"><input id="blacklist-new" type="text" spellCheck={false} autoComplete="off" placeholder="例如：git push、生产环境、.env" value={keyword}
          disabled={busy} aria-describedby="blacklist-new-help" onChange={event => setKeyword(event.target.value)} onPaste={event => {
            // A single-line input would join a pasted list into one keyword; keep one tag per line instead.
            const text = event.clipboardData.getData('text')
            if (!/\r?\n/.test(text.trim())) return
            event.preventDefault()
            update({ automation: { blacklist: [...auto.blacklist, ...text.split(/\r?\n/)] } })
            setKeyword('')
          }} />
          <button type="submit" className="settings-button" disabled={busy || !keyword.trim() || duplicate}>添加</button></div>
        <p className="setting-hint" id="blacklist-new-help" role="status">{duplicate ? '这个关键词已经在黑名单里了。' : '添加或移除后立即生效。'}</p>
      </form>
      <div className="setting-field">
        <label htmlFor="blacklist-probe">试一试</label>
        <input id="blacklist-probe" type="text" spellCheck={false} autoComplete="off" placeholder="粘贴一条命令或问题，看它会被怎样处理" value={probe}
          onChange={event => setProbe(event.target.value)} />
        {verdict && <p className="blacklist-verdict" data-tone={verdict.tone} role="status"><Dot tone={verdict.tone} /><span><b>{verdict.title}</b>　{verdict.text}</span></p>}
      </div>
    </Group>
  </>
}
