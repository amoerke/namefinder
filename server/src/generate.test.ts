import { describe, expect, it, vi } from 'vitest';
import type { GenerateRequest } from '../../shared/types.ts';
import { createAnthropicGenerator, createOpenAIGenerator, filterNames, GenerationError } from './generate.ts';

const n = (name: string, parts = [name]) => ({ name, parts, rationale: 'Passt.' });

describe('filterNames', () => {
  it('filtert Sonderzeichen, Umlaute, Länge, Dubletten und Ausschlusswörter', () => {
    const out = filterNames(
      [n('SonnenPlan', ['Sonnen', 'Plan']), n('Sonnen-Plan'), n('Grün'), n('Mit Leer'), n('sonnenplan'), n('Sehrlangername12345'), n('Strombude'), n('Lumio')],
      { maxLength: 12, count: 10, exclude: 'bude' },
    );
    expect(out.map((x) => x.name)).toEqual(['SonnenPlan', 'Lumio']);
    expect(out[0]!.parts).toEqual(['Sonnen', 'Plan']);
  });
  it('korrigiert inkonsistente parts und begrenzt die Anzahl', () => {
    const out = filterNames([n('NovaWerk', ['Nova', 'Werke']), n('Abc'), n('Def')], { maxLength: 20, count: 2, exclude: '' });
    expect(out).toHaveLength(2);
    expect(out[0]!.parts).toEqual(['NovaWerk']);
  });
});

describe('createAnthropicGenerator – Fehlermeldungen', () => {
  const req: GenerateRequest = { description: 'Solarmontage', tags: [], language: 'de', styles: ['kunstwort'], maxLength: 12, count: 10, mustInclude: '', exclude: '' };
  const apiError = (status: number, message: string) =>
    (async () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

  it('meldet aufgebrauchtes API-Guthaben verständlich und loggt den Originalfehler', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const generate = createAnthropicGenerator({
      apiKey: 'test',
      model: 'claude-sonnet-5-5',
      fetch: apiError(400, 'Your credit balance is too low to access the Anthropic API.'),
    });
    const err = await generate(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GenerationError);
    expect((err as GenerationError).message).toContain('Guthaben');
    expect((err as GenerationError).status).toBe(503);
    expect(log.mock.calls.flat().join(' ')).toContain('credit balance is too low');
    log.mockRestore();
  });

  it('behält die allgemeine Meldung für andere ungültige Anfragen', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const generate = createAnthropicGenerator({ apiKey: 'test', model: 'claude-sonnet-5-5', fetch: apiError(400, 'max_tokens: too large') });
    const err = await generate(req).catch((e: unknown) => e);
    expect((err as GenerationError).message).toContain('ungültig');
    log.mockRestore();
  });
});

describe('createOpenAIGenerator', () => {
  const req: GenerateRequest = { description: 'Solarmontage', tags: [], language: 'de', styles: ['kunstwort'], maxLength: 12, count: 10, mustInclude: '', exclude: '' };
  const respond = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  it('liest strukturierte Namen aus der Responses-API', async () => {
    const names = { names: [{ name: 'SonnenPlan', parts: ['Sonnen', 'Plan'], rationale: 'Passt.' }, { name: 'Sonnen-Plan', parts: ['Sonnen-Plan'], rationale: 'x' }] };
    const generate = createOpenAIGenerator({
      apiKey: 'test',
      model: 'gpt-5.5',
      fetch: respond(200, {
        id: 'resp_1', object: 'response', created_at: 0, status: 'completed', model: 'gpt-5.5', incomplete_details: null,
        output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: JSON.stringify(names), annotations: [] }] }],
      }),
    });
    const out = await generate(req);
    expect(out.map((n) => n.name)).toEqual(['SonnenPlan']);
    expect(out[0]!.parts).toEqual(['Sonnen', 'Plan']);
  });

  it('meldet aufgebrauchtes OpenAI-Guthaben verständlich', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const generate = createOpenAIGenerator({
      apiKey: 'test',
      model: 'gpt-5.5',
      fetch: respond(429, { error: { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' } }),
    });
    const err = (await generate(req).catch((e: unknown) => e)) as GenerationError;
    expect(err).toBeInstanceOf(GenerationError);
    expect(err.message).toContain('Guthaben des OpenAI');
    expect(log.mock.calls.flat().join(' ')).toContain('exceeded your current quota');
    log.mockRestore();
  });

  it('erkennt Ablehnungen', async () => {
    const generate = createOpenAIGenerator({
      apiKey: 'test',
      model: 'gpt-5.5',
      fetch: respond(200, {
        id: 'resp_2', object: 'response', created_at: 0, status: 'completed', model: 'gpt-5.5', incomplete_details: null,
        output: [{ type: 'message', id: 'msg_2', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'Nein.' }] }],
      }),
    });
    const err = (await generate(req).catch((e: unknown) => e)) as GenerationError;
    expect(err.status).toBe(422);
  });
});
