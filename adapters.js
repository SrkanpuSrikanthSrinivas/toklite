// Adapters give the reducers one uniform way to read and rewrite the text
// inside a request, regardless of whether it is Anthropic- or OpenAI-shaped.
// Nothing else in the pipeline needs to know the wire format.

export function detectFormat(pathname) {
  if (pathname.includes('/messages')) return 'anthropic';
  if (pathname.includes('/chat/completions') || pathname.includes('/responses')) return 'openai';
  return null;
}

/**
 * Returns an array of handles over every addressable chunk of text in the body:
 *   { role, turn, kind, get(), set(v) }
 * turn = index in the message array (-1 for system prompt).
 * kind = 'system' | 'text' | 'tool_result'
 */
export function walkTexts(body, format) {
  const handles = [];

  const pushBlockArray = (arr, role, turn) => {
    arr.forEach((block, i) => {
      if (typeof block === 'string') {
        handles.push({
          role, turn, kind: 'text',
          get: () => arr[i],
          set: (v) => { arr[i] = v; }
        });
      } else if (block && typeof block === 'object') {
        if (typeof block.text === 'string') {
          handles.push({
            role, turn, kind: block.type === 'tool_result' ? 'tool_result' : 'text',
            get: () => block.text,
            set: (v) => { block.text = v; }
          });
        }
        // Anthropic tool_result blocks nest their payload one level deeper.
        if (block.type === 'tool_result' && Array.isArray(block.content)) {
          block.content.forEach((inner, j) => {
            if (inner && typeof inner.text === 'string') {
              handles.push({
                role, turn, kind: 'tool_result',
                get: () => block.content[j].text,
                set: (v) => { block.content[j].text = v; }
              });
            }
          });
        }
      }
    });
  };

  if (format === 'anthropic') {
    if (typeof body.system === 'string') {
      handles.push({
        role: 'system', turn: -1, kind: 'system',
        get: () => body.system,
        set: (v) => { body.system = v; }
      });
    } else if (Array.isArray(body.system)) {
      pushBlockArray(body.system, 'system', -1);
    }
  }

  (body.messages || []).forEach((msg, turn) => {
    const role = msg.role === 'system' ? 'system' : msg.role;
    if (typeof msg.content === 'string') {
      handles.push({
        role, turn, kind: role === 'tool' ? 'tool_result' : (role === 'system' ? 'system' : 'text'),
        get: () => msg.content,
        set: (v) => { msg.content = v; }
      });
    } else if (Array.isArray(msg.content)) {
      pushBlockArray(msg.content, role, turn);
    }
  });

  return handles;
}

export function turnCount(body) {
  return (body.messages || []).length;
}

/** Normalized cache key input: model + all text + tool names + decoding params. */
export function cacheSignature(body, format) {
  const texts = walkTexts(body, format).map(h => `${h.role}:${h.get()}`);
  const tools = (body.tools || []).map(t => t.name || t.function?.name || '').sort();
  return JSON.stringify({
    model: body.model,
    temperature: body.temperature ?? null,
    top_p: body.top_p ?? null,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? null,
    tools,
    texts
  });
}
