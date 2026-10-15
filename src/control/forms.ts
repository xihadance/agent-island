import type { Question } from './types'

/** Only advertise forms whose constraints can be represented and validated locally. */
export function formQuestions(schema: unknown): Question[] | undefined {
  if (!schema || typeof schema !== 'object') return undefined
  const object = schema as Record<string, any>
  if (object.type !== 'object' || !object.properties || typeof object.properties !== 'object' || Array.isArray(object.properties)) return undefined
  if (Object.keys(object).some(key => !['type', 'properties', 'required', 'title', 'description', 'additionalProperties', '$schema'].includes(key))) return undefined
  if (object.additionalProperties !== undefined && typeof object.additionalProperties !== 'boolean') return undefined
  const questions: Question[] = []
  for (const [id, raw] of Object.entries(object.properties)) {
    if (!raw || typeof raw !== 'object' || ['__proto__', 'constructor', 'prototype'].includes(id)) return undefined
    const field = raw as Record<string, any>
    if (!['string', 'boolean'].includes(field.type) || Object.keys(field).some(key => !['type', 'enum', 'title', 'description', 'default'].includes(key))) return undefined
    if (field.enum && (!Array.isArray(field.enum) || !field.enum.length || field.enum.some((v: unknown) => typeof v !== field.type))) return undefined
    questions.push({ id, text: `${field.title ?? id}${field.description ? ` — ${field.description}` : ''}`, options: field.type === 'boolean' ? (field.enum ?? [true, false]).map(String) : field.enum ?? [], multi: false, freeText: field.type === 'string' && !field.enum, valueType: field.type })
  }
  return questions.length > 0 && questions.length <= 10 ? questions : undefined
}
export function formAnswers(questions: Question[], answers: Record<string, string[]>): Record<string, string | boolean> {
  return Object.fromEntries(questions.map(q => [q.id, q.valueType === 'boolean' ? answers[q.id][0] === 'true' : answers[q.id][0]]))
}
