import { AIService } from './ai.service';

function serviceReturning(answer: any) {
  const svc: any = Object.create(AIService.prototype);
  svc.logger = { warn: () => {}, error: () => {} };
  svc.callGeminiWithTokens = async () => ({ text: typeof answer === 'string' ? answer : JSON.stringify(answer), inputTokens: 1, outputTokens: 1 });
  return svc as AIService;
}

const chat = [
  { isFromMe: true, text: 'what do you want to eat?' },
  { isFromMe: false, text: 'I love pani puri, it is my favourite' },
  { isFromMe: false, text: 'mala late night walks khup awadtat' },
  { isFromMe: true, text: 'I hate waking up early' },
  { isFromMe: false, text: 'I really hate loud music' },
  { isFromMe: false, text: 'I cannot stand waiting in traffic' },
];

describe('contact likes and dislikes', () => {
  it('keeps items proven by the contact own words', async () => {
    const r = await serviceReturning({
      likes: [{ item: 'pani puri', evidence: 'I love pani puri' }, { item: 'late night walks', evidence: 'late night walks khup awadtat' }],
      dislikes: [{ item: 'loud music', evidence: 'I really hate loud music' }],
      confidence: 0.9,
    }).generateContactProfile('Namrata', chat);
    expect(r.likes.map((l) => l.item)).toEqual(['pani puri', 'late night walks']);
    expect(r.dislikes.map((l) => l.item)).toEqual(['loud music']);
    expect(r.confidence).toBe(0.9);
  });

  it('never uses what the user said ("Me") as the contact opinion', async () => {
    const r = await serviceReturning({ likes: [], dislikes: [{ item: 'waking up early', evidence: 'I hate waking up early' }], confidence: 0.8 })
      .generateContactProfile('Namrata', chat);
    expect(r.dislikes).toHaveLength(0);
  });

  it('drops anything the chat does not prove (invented or paraphrased)', async () => {
    const r = await serviceReturning({
      likes: [{ item: 'cricket', evidence: 'I love watching cricket' }, { item: 'food', evidence: '' }, { item: 'x' }],
      dislikes: [],
      confidence: 0.9,
    }).generateContactProfile('Namrata', chat);
    expect(r.likes).toHaveLength(0);
  });

  it('removes duplicates, caps at 8, and never lists the same thing as like and dislike', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ item: `thing ${i}`, evidence: 'I love pani puri' }));
    const r = await serviceReturning({
      likes: [...many, { item: 'THING 0', evidence: 'I love pani puri' }],
      dislikes: [{ item: 'thing 1', evidence: 'I really hate loud music' }],
      confidence: 2,
    }).generateContactProfile('Namrata', chat);
    expect(r.likes.length).toBeLessThanOrEqual(8);
    expect(r.likes.find((l) => l.item === 'thing 1')).toBeUndefined();
    expect(r.confidence).toBe(1);
  });

  it('an empty answer is a valid result, not an error', async () => {
    const r = await serviceReturning({ likes: [], dislikes: [], confidence: 0.2 }).generateContactProfile('Namrata', chat);
    expect(r.likes).toEqual([]);
    expect(r.dislikes).toEqual([]);
  });

  it('bad model output is reported, not saved as an empty profile', async () => {
    await expect(serviceReturning('not json').generateContactProfile('Namrata', chat)).rejects.toMatchObject({ category: 'INVALID_RESPONSE' });
    await expect(serviceReturning({}).generateContactProfile('Namrata', [])).rejects.toThrow('NO_MESSAGES');
  });
});
