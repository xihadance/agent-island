import { useEffect, useState } from 'react'
import { ActivityIcon } from '../renderer/src/activity-icons'
import { ClaudeIcon, CodexIcon, CursorIcon, GeminiIcon } from '../renderer/src/agent-icons'
import { IslandDemo } from './IslandDemo'
import introVideo from '../../media/cute-island-intro.mp4'
import introPoster from '../../media/intro-poster.png'
import brandIcon from '../../build/icon.png'

const GITHUB = 'https://github.com/xihadance/agent-island'
const features = [
  { title: '进度，不用来回切窗口', copy: '哪个 Agent、在哪个客户端、正在做什么、已经花了多久。展开小岛，连子任务也一眼看清。', kind: 'agent' },
  { title: '该你出手时，才提醒你', copy: '需要审批、回答问题或出现明确异常时，小岛主动展开。普通进度刷新不会反复打断你。', kind: 'approval' },
  { title: '专注自己的事，小岛安静守着', copy: '空闲时收成细条，贴边时自动收纳。托管模式让鼠标穿透，把桌面留给你正在做的事。', kind: 'waiting' }
] as const

const faqs = [
  { question: '需要重新配置我的 Agent 吗？', answer: '查看状态不需要。Cute Island 读取本机 Agent 已有的会话日志，启动后自动识别。若要处理审批和回答问题，需要在设置中安装对应的原生接入，并重新打开终端或 Agent 会话。' },
  { question: '它会自动批准所有操作吗？', answer: '自动审批默认关闭，由你按类型开启规则。Claude Code 和 Codex 支持自动审批；Cursor 与 Gemini 使用各自的远程 Hook 门禁，原生权限策略仍然生效。仅仅读取日志不会批准操作。' },
  { question: '我的代码会上传到哪里？', answer: '状态识别在本机完成。开启远程接管后，必要的提醒与请求会发送到你配置的消息渠道，外发文本会先脱敏。渠道凭据通过环境变量读取；配置里保存的是变量名。' },
  { question: '可以接管已经运行的 Codex 会话吗？', answer: '需要会话连接到同一个 Codex app-server。独立启动的 CLI、桌面应用和 IDE 插件会话不会自动迁入。可安装 Codex 命令接入，让后续启动的终端会话按当前设置连接。' },
  { question: '支持哪些系统？收费吗？', answer: '支持 Windows、macOS 和 Linux。项目采用 MIT 开源许可，源码公开，可从 GitHub Releases 下载各平台安装包，也可以自行构建。' }
]

function Brand({ footer = false }: { footer?: boolean }) {
  return <a className={`brand${footer ? ' footer-brand' : ''}`} href="#top" aria-label="Cute Island 首页">
    <img src={brandIcon} alt="" width="36" height="36" /><span>Cute Island</span>
  </a>
}

function Arrow() {
  return <span className="arrow" aria-hidden="true"><span /></span>
}

function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('cute-island-site-theme')
      if (saved === 'light' || saved === 'dark') return saved
    } catch { /* An embedded preview may block storage. */ }
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#151816' : '#f5f6f3')
  }, [theme])
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const update = () => {
      try { if (localStorage.getItem('cute-island-site-theme')) return } catch { /* Follow the system when storage is unavailable. */ }
      setTheme(media.matches ? 'dark' : 'light')
    }
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return { theme, toggle: () => {
    const next = theme === 'light' ? 'dark' : 'light'
    setTheme(next)
    try { localStorage.setItem('cute-island-site-theme', next) } catch { /* The theme still works without persistence. */ }
  } }
}

export function Website() {
  const { theme, toggle } = useTheme()
  const [menuOpen, setMenuOpen] = useState(false)
  const [feature, setFeature] = useState(0)
  const [videoError, setVideoError] = useState(false)

  return <>
    <a className="skip-link" href="#main">跳到正文</a>
    <header className="site-header" id="top">
      <div className="header-inner">
        <Brand />
        <nav className={menuOpen ? 'navigation is-open' : 'navigation'} aria-label="主导航" id="navigation"
          onClick={() => setMenuOpen(false)} onKeyDown={event => { if (event.key === 'Escape') { setMenuOpen(false); document.getElementById('menu-toggle')?.focus() } }}>
          <a href="#features">功能</a><a href="#remote">远程接管</a><a href="#faq">常见问题</a>
          <a className="nav-github" href={GITHUB} target="_blank" rel="noopener noreferrer">GitHub <Arrow /></a>
        </nav>
        <div className="header-controls">
          <button className="theme-toggle" onClick={toggle} aria-label={`切换到${theme === 'light' ? '深色' : '浅色'}主题`}>
            <span className={`theme-symbol ${theme}`} aria-hidden="true" />
          </button>
          <button className="menu-toggle" id="menu-toggle" aria-controls="navigation" aria-expanded={menuOpen}
            aria-label={menuOpen ? '关闭导航菜单' : '打开导航菜单'} onClick={() => setMenuOpen(value => !value)}>
            <span /><span />
          </button>
        </div>
      </div>
    </header>

    <main id="main">
      <section className="hero container" aria-labelledby="hero-title">
        <div className="hero-copy">
          <h1 id="hero-title">让 Agent 忙。<br /><span>让自己轻松一点。</span></h1>
          <p>你的 AI Agent，在一个小岛上。<br />看进度、接提醒，人不在电脑前也能接管。</p>
          <div className="hero-actions">
            <a className="button primary" href={GITHUB} target="_blank" rel="noopener noreferrer">在 GitHub 查看源码 <Arrow /></a>
            <a className="text-link" href="#features"><span className="play-symbol" aria-hidden="true" />看看它怎么工作</a>
          </div>
        </div>
        <IslandDemo />
      </section>

      <section className="agents container" aria-label="支持的 Agent">
        <div className="agents-caption">你熟悉的 Agent，<br /><strong>现在有了共同的小岛。</strong></div>
        <div className="agent-logo claude"><ClaudeIcon /><span>Claude Code</span></div>
        <div className="agent-logo codex"><CodexIcon /><span>Codex</span></div>
        <div className="agent-logo gemini"><GeminiIcon id="site-gemini" /><span>Gemini</span></div>
        <div className="agent-logo cursor"><CursorIcon /><span>Cursor</span></div>
      </section>

      <section className="features container" id="features" aria-labelledby="features-title">
        <div className="section-heading"><h2 id="features-title">少盯一个窗口，<br />多一点自己的时间。</h2>
          <p>把后台的忙碌收进屏幕顶部，只在真正需要你时出现。</p>
        </div>
        <div className="feature-layout">
          <div className="product-film">
            <video controls playsInline preload="none" poster={introPoster} onError={() => setVideoError(true)} aria-label="Cute Island 功能介绍视频，60 秒">
              <source src={introVideo} type="video/mp4" />
              你的浏览器不支持视频播放。<a href={introVideo}>下载介绍视频</a>
            </video>
            <div className="film-caption"><span>从一条胶囊，到桌面的好帮手</span><a href={introVideo}>完整演示 · 60 秒 <Arrow /></a></div>
            {videoError && <p className="video-error" role="alert">视频暂时无法播放，可以<a href={introVideo}>下载后观看</a>。</p>}
          </div>
          <div className="feature-list">
            {features.map((item, index) => <div key={item.title} className={`feature-item${feature === index ? ' is-active' : ''}`}>
              <h3><button aria-expanded={feature === index} aria-controls={`feature-${index}`} onClick={() => setFeature(index)}>
                <ActivityIcon kind={item.kind} /><span>{item.title}</span><span className="expand-mark" aria-hidden="true">{feature === index ? '−' : '+'}</span>
              </button></h3>
              <div id={`feature-${index}`} hidden={feature !== index}><p>{item.copy}</p></div>
            </div>)}
            <p className="feature-footnote">观察只读本机日志，审批通过原生通道回传。</p>
          </div>
        </div>
      </section>

      <section className="remote-section" id="remote" aria-labelledby="remote-title">
        <div className="container remote-inner">
          <div className="remote-copy"><h2 id="remote-title">离开电脑，<br />也不用让任务等你。</h2>
            <p>去喝杯咖啡，或者出门走走。需要你确认时，消息会来到手机上；审批、回答、追加指令，都可以从已接入的渠道处理。</p>
            <a className="text-link" href={`${GITHUB}/blob/main/REMOTE_CONTROL.md`} target="_blank" rel="noopener noreferrer">阅读远程接管指南 <Arrow /></a>
          </div>
          <div className="remote-flow" aria-label="远程接管流程">
            <div className="flow-origin"><span className="flow-island" aria-hidden="true"><i /><i /><i /></span><strong>电脑上的 Agent</strong><span>需要审批或回答</span></div>
            <div className="flow-connector" aria-hidden="true"><span /></div>
            <div className="flow-destination"><strong>你手机上的消息渠道</strong><div className="channels"><span>Telegram</span><span>飞书</span><span>企业微信</span><span>Discord</span></div></div>
            <p>配置渠道 → 接收提醒 → 回传处理结果</p>
          </div>
        </div>
      </section>

      <section className="principles container" aria-label="设计原则">
        <div><ActivityIcon kind="read" /><h3>本机观察</h3><p>从已有日志还原状态，<br />不向 Agent 注入内容。</p></div>
        <div><ActivityIcon kind="approval" /><h3>控制由你决定</h3><p>自动审批默认关闭，<br />按你设置的规则处理。</p></div>
        <div><ActivityIcon kind="edit" /><h3>跨平台，开源</h3><p>Windows、macOS、Linux。<br />MIT 许可，自由查看与构建。</p></div>
      </section>

      <section className="faq container" id="faq" aria-labelledby="faq-title">
        <div className="faq-intro"><h2 id="faq-title">开始之前，<br />你可能想知道。</h2><p>关于接入、权限和你自己的数据。</p>
          <a className="text-link" href={`${GITHUB}/blob/main/README.md`} target="_blank" rel="noopener noreferrer">查看完整文档 <Arrow /></a>
        </div>
        <div className="faq-list">{faqs.map(item => <details key={item.question}><summary>{item.question}<span className="faq-plus" aria-hidden="true" /></summary><p>{item.answer}</p></details>)}</div>
      </section>

      <section className="closing container" aria-labelledby="closing-title">
        <div className="closing-mark" aria-hidden="true"><span /><span /><span /></div>
        <h2 id="closing-title">给忙碌的 Agent，<br />安一个小小的家。</h2><p>小岛很小，你的桌面和时间，可以更自由。</p>
        <div className="closing-actions"><a className="button primary" href={GITHUB} target="_blank" rel="noopener noreferrer">探索 GitHub 项目 <Arrow /></a>
          <a className="text-link" href={`${GITHUB}/releases/latest`} target="_blank" rel="noopener noreferrer">下载安装包 <Arrow /></a></div>
      </section>
    </main>

    <footer className="site-footer container"><Brand footer /><span>一个小岛，看住你的 AI Agent。</span>
      <div><a href={`${GITHUB}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">MIT 开源</a><a href={`${GITHUB}/issues`} target="_blank" rel="noopener noreferrer">反馈与建议 <Arrow /></a></div>
    </footer>
  </>
}
