// DSH's `attachments` service for generic files, in memory. Reads come back in small
// chunks that split characters, as a stream may.
export function fakeAttachments() {
  const files = new Map()
  return {
    files,
    async saveFile({ data, name }) {
      const ref = { attachmentId: `sha256:${files.size + 1}`, name, bytes: data.length }
      files.set(ref.attachmentId, data)
      return ref
    },
    async* readFileStream(ref) {
      const data = files.get(ref.attachmentId)
      if (data === undefined) throw new Error('no such file')
      for (let at = 0; at < data.length; at += 1001) yield data.subarray(at, at + 1001)
    },
  }
}

export function fakeApproval(outcome = 'allowed-once') {
  const requests = []
  return {
    requests,
    async request(request) {
      requests.push(request)
      return typeof outcome === 'function' ? outcome(requests.length, request) : outcome
    },
  }
}

// A stand-in for the plugin context that records what apply() registers, in order,
// without starting any service.
export function fakeContext({ services = {} } = {}) {
  const calls = []
  const disposers = []
  const registeredTools = new Map()
  const guards = []
  // Listeners by event name, in registration order.
  const listeners = new Map()
  const sections = new Map()
  const ctx = {
    calls,
    registeredTools,
    guards,
    listeners,
    sections,
    logger: { warn() {}, info() {} },
    get: name => services[name],
    on(name, listener, options) {
      calls.push(`on ${name}${options?.prepend ? ' (prepend)' : ''}`)
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return () => {}
    },
    // Calls the plain listeners of an event; middleware (with `next`) is not run.
    emit(name, payload) {
      for (const listener of listeners.get(name) ?? []) {
        if (listener.length < 2) listener(payload)
      }
    },
    effect(execute, label) {
      calls.push(`effect ${label}`)
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    // Settles once every cleanup has, including the writes some of them wait for.
    dispose() {
      return Promise.allSettled(disposers.splice(0).reverse().map(dispose => dispose()))
    },
    tools: {
      register(tool) {
        calls.push(`tool ${tool.name}`)
        registeredTools.set(tool.name, tool)
        return () => {}
      },
      guard(guard) {
        calls.push('tools guard')
        guards.push(guard)
        return () => {}
      },
      schemas: () => [],
    },
    systemPrompt: {
      section(section) {
        calls.push(`prompt ${section.name} ${section.order}`)
        sections.set(section.name, section)
        return () => {}
      },
    },
    connection: {
      fetch: {
        register(route) {
          calls.push(`route ${route.methods.join(',')} ${route.path}`)
          return () => {}
        },
      },
    },
    llm: { listProviders: () => [] },
  }
  return ctx
}
