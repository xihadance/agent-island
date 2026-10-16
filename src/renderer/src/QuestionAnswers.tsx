import { useState, type FormEvent } from 'react'
import { STATUS_LABEL } from '../../control/types'
import { selectedAnswers, type QuestionRequest } from '../../shared/question-request'
import { getBridge } from './bridge'

export function QuestionAnswers({ request }: { request: QuestionRequest }) {
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = request.status === 'pending'
  const disabled = busy || !pending || !request.connected || request.expiresAt <= Date.now()
  const answers = selectedAnswers(request.questions, selections, texts)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!answers || disabled) return
    setBusy(true)
    setError('')
    try { await getBridge().answerQuestion(request.id, request.revision, answers) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '提交失败，请重新查看问题状态') }
    finally { setBusy(false) }
  }
  return <form className="question-answers" data-testid="question-answers" onSubmit={event => void submit(event)} onClick={event => event.stopPropagation()}>
    <p className="question-hint" role="status">{pending ? request.connected ? '可在这里或远程渠道回答；提交后两端同步。' : '会话已断开，请在原 Agent 中查看。' : STATUS_LABEL[request.status]}</p>
    {request.questions.map((question, index) => <fieldset key={question.id} disabled={disabled}>
      <legend>{request.questions.length > 1 ? `${index + 1}. ` : ''}{question.text}{question.multi ? '（多选）' : ''}</legend>
      {question.options.map((option, optionIndex) => {
        const selected = pending ? selections[question.id]?.includes(option) ?? false : request.decision?.answers?.[question.id]?.includes(option) ?? false
        return <label className="question-option" key={optionIndex} data-selected={selected}>
          <input type={question.multi ? 'checkbox' : 'radio'} name={`${request.id}-${question.id}`} checked={selected} onChange={() => {
            setSelections(previous => ({ ...previous, [question.id]: question.multi ? selected ? (previous[question.id] ?? []).filter(value => value !== option) : [...(previous[question.id] ?? []), option] : [option] }))
            if (!question.multi) setTexts(previous => ({ ...previous, [question.id]: '' }))
          }} />
          <span><strong>{option}</strong>{question.descriptions?.[optionIndex] && <small>{question.descriptions[optionIndex]}</small>}</span>
        </label>
      })}
      {question.freeText && pending && <label className="question-text">{question.options.length ? '其他回答' : '你的回答'}
        <textarea rows={2} maxLength={4000} value={texts[question.id] ?? ''} placeholder={question.multi ? '可补充其他内容' : '输入回答后将使用此内容'} onChange={event => {
          setTexts(previous => ({ ...previous, [question.id]: event.target.value }))
          if (!question.multi && event.target.value.trim()) setSelections(previous => ({ ...previous, [question.id]: [] }))
        }} />
      </label>}
      {!pending && request.decision?.answers?.[question.id] && <p className="question-hint">已提交：{request.decision.answers[question.id].join('、')}</p>}
    </fieldset>)}
    {error && <p className="question-error" role="alert">{error}</p>}
    {pending && <button className="close question-submit" type="submit" disabled={disabled || !answers}>{busy ? '正在提交…' : '提交回答'}</button>}
  </form>
}
