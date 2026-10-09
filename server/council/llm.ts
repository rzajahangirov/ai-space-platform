// Model access for council seats. Each call is short (small output caps, low reasoning effort) and
// returns JSON that matches a schema. Calls carry an AbortSignal bound to the session deadline.
export type Seat = 'openai' | 'google';
export const seats: Seat[] = ['openai', 'google'];
export const seatLabel: Record<Seat, string> = { openai: 'ChatGPT', google: 'Gemini' };

export interface ChatRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  signal: AbortSignal;
}
export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}
export interface CouncilLLM {
  model(seat: Seat): string;
  chat(seat: Seat, request: ChatRequest): Promise<ChatResult>;
  /** Returns null when embeddings are unavailable; RAG then falls back to keyword ranking. */
  embed(
    texts: string[],
    signal: AbortSignal,
  ): Promise<{ vectors: number[][]; tokens: number } | null>;
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  // Provider bodies are not echoed: they can contain submitted project content.
  if (!response.ok) throw new Error(`Provider request failed (${response.status}).`);
  return response.json() as Promise<any>;
}

export class HttpCouncilLLM implements CouncilLLM {
  model(seat: Seat) {
    return seat === 'openai'
      ? process.env.COUNCIL_OPENAI_MODEL || process.env.OPENAI_MODEL || 'gpt-5.5'
      : process.env.COUNCIL_GOOGLE_MODEL || 'gemini-flash-latest';
  }
  async chat(seat: Seat, r: ChatRequest): Promise<ChatResult> {
    const model = this.model(seat);
    if (seat === 'openai') {
      if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.');
      const data = await post(
        'https://api.openai.com/v1/responses',
        { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        {
          model,
          instructions: r.system,
          input: r.user,
          max_output_tokens: r.maxOutputTokens,
          store: false,
          ...(/^(gpt-5|gpt-6|o\d)/.test(model) ? { reasoning: { effort: 'low' } } : {}),
          text: {
            format: { type: 'json_schema', name: 'council', strict: true, schema: r.schema },
          },
        },
        r.signal,
      );
      const text = (data.output ?? [])
        .flatMap((o: any) => o.content ?? [])
        .filter((c: any) => c.type === 'output_text')
        .map((c: any) => c.text)
        .join('');
      if (!text) throw new Error('ChatGPT returned no answer within its output limit.');
      return {
        text,
        model,
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      };
    }
    if (!process.env.GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY is not configured.');
    const data = await post(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { 'x-goog-api-key': process.env.GOOGLE_API_KEY },
      {
        systemInstruction: { parts: [{ text: r.system }] },
        contents: [{ role: 'user', parts: [{ text: r.user }] }],
        generationConfig: {
          maxOutputTokens: r.maxOutputTokens,
          responseMimeType: 'application/json',
          responseJsonSchema: r.schema,
          thinkingConfig: { thinkingLevel: 'low' },
        },
      },
      r.signal,
    );
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .filter((p: any) => !p.thought)
      .map((p: any) => p.text ?? '')
      .join('');
    if (!text) throw new Error('Gemini returned no answer within its output limit.');
    const u = data.usageMetadata ?? {};
    return {
      text,
      model,
      inputTokens: u.promptTokenCount ?? 0,
      outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    };
  }
  async embed(texts: string[], signal: AbortSignal) {
    if (!process.env.OPENAI_API_KEY || !texts.length) return null;
    try {
      const data = await post(
        'https://api.openai.com/v1/embeddings',
        { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        { model: process.env.COUNCIL_EMBEDDING_MODEL || 'text-embedding-3-small', input: texts },
        signal,
      );
      return {
        vectors: data.data.map((d: any) => d.embedding as number[]),
        tokens: data.usage?.total_tokens ?? 0,
      };
    } catch {
      return null;
    }
  }
}
