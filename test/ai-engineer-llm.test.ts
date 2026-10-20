const mockCreate = jest.fn();
jest.mock('openai', () => ({ __esModule: true, default: jest.fn(() => ({ chat: { completions: { create: mockCreate } } })) }));
import cache from '../src/cache';
import * as ai from '../src/ai-engineer';
import { getEngineerConclusion } from '../src/addons/llm';

describe('internal AI engineer conclusion', () => {
  const policy: ai.EngineerPolicy = { enabled: true, scope: 'most-support-vm3902', staff: [{ telegram_id: '1', role: 'admin' }] };
  const job = ai.createTask({ ticketId: 1, status: 'open', assigned_to: null }, policy, '1',
    { binding_id: 'canary', binding_version: 1, display_label: 'Canary', profile_id: ai.PROFILE },
    ai.snapshotInput('Доступность. password=must-not-reach-model\nhttps://secret.example/subscription'), Date.now());
  job.checks = { status: 'partial', execution_allowed: false, completed_at: Date.now(),
    facts: [{ ref: 'check-1', check_id: ai.PROFILE, observed_at: Date.now(), values: { reachable: true, uptime_seconds: null } }], unknowns: ['uptime_metric_unavailable'] };
  const result: ai.Conclusion = { summary: 'Проверка завершена', verified_findings: [{ text: 'Хост доступен', evidence_refs: ['check-1'] }],
    hypotheses: [], unknowns: ['Числовая метрика uptime недоступна'], recommended_next_steps: ['Уточнить симптомы'],
    customer_reply_draft: 'Проверяем ваше обращение.' };
  beforeEach(() => {
    mockCreate.mockReset(); cache.config.llm_model = 'configured-model'; cache.config.llm_api_key = 'test-key-value';
    mockCreate.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(result) } }] });
  });
  it('uses the configured model without tools and bounds real SDK retries/timeout', async () => {
    expect(await getEngineerConclusion(job)).toEqual(result);
    const [request, options] = mockCreate.mock.calls[0];
    expect(request.model).toBe('configured-model'); expect(request.tools).toBeUndefined();
    expect(options).toEqual({ timeout: 45_000, maxRetries: 0 });
    expect(JSON.stringify(request.messages)).not.toMatch(/must-not-reach-model|secret\.example|test-key-value/);
  });
  it('rejects invented evidence and non-JSON output', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...result,
      verified_findings: [{ text: 'Неизвестный результат', evidence_refs: ['invented'] }] }) } }] });
    await expect(getEngineerConclusion(job)).rejects.toThrow('evidence_unknown');
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'not JSON' } }] });
    await expect(getEngineerConclusion(job)).rejects.toThrow();
  });
  it('forwards the worker cancellation signal to the SDK', async () => {
    const controller = new AbortController();
    await getEngineerConclusion(job, controller.signal);
    expect(mockCreate.mock.calls[0][1].signal).toBe(controller.signal);
  });
  it('excludes arbitrary ticket history and credential URIs of non-HTTP schemes', async () => {
    const input = { ...job.input, history: 'PRIVATE_CUSTOMER_HISTORY', goal: 'mongodb://support:plain-password@db.internal/support',
      feedback: 'postgresql://user:another-secret@host/db' };
    await getEngineerConclusion({ ...job, input });
    const sent = JSON.stringify(mockCreate.mock.calls[0][0].messages);
    expect(sent).not.toMatch(/PRIVATE_CUSTOMER_HISTORY|plain-password|another-secret|db\.internal/);
  });
  it('does not start a request without explicit model configuration', async () => {
    cache.config.llm_model = '';
    await expect(getEngineerConclusion(job)).rejects.toThrow('model_unavailable');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
