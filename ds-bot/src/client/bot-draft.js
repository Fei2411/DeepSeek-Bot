// Plain helpers for the Create Bot form, kept free of React so tests can load them.

export function freshBotName(roster, base = 'New Bot') {
  const taken = new Set(roster.bots.map(bot => bot.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  let index = 2
  while (taken.has(`${base.toLowerCase()} ${index}`)) index += 1
  return `${base} ${index}`
}

// The form starts on the DSH default model when it is usable, else the first usable
// one. A model whose provider has no key fails every turn, so with none usable the form
// starts on none and the new Bot waits for a pick.
export function startModel(roster) {
  const usable = (roster.models ?? []).filter(model => !model.needsKey)
  return (usable.find(model => model.ref === roster.defaultModel) ?? usable[0])?.ref ?? ''
}

// A chosen model is always sent: the host fixes it on the Bot at creation.
export function createPayload({ name, look, image, model, effort, brief }) {
  const payload = { name, color: look.color, avatar: image ? { shape: look.shape, image } : { shape: look.shape } }
  if (model) payload.model = model
  if (effort !== undefined) payload.effort = effort
  if (brief) payload.brief = brief
  return payload
}
