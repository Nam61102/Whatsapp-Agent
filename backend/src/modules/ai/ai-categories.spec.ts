import { AIService } from './ai.service';
import { EXTRACTION_TYPES, buildItemKey } from './ai-extraction.types';

function serviceReturning(answer: any) {
  const svc: any = Object.create(AIService.prototype);
  svc.logger = { warn: () => {}, error: () => {} };
  svc.callGeminiWithTokens = async () => ({ text: JSON.stringify(answer), inputTokens: 1, outputTokens: 1 });
  return svc as AIService;
}

const SENT = new Date('2026-10-15T08:00:00Z');
const item = (type: string, excerpt: string, over: any = {}) => ({
  type,
  title: `${type} item`,
  description: excerpt,
  supportingText: excerpt,
  dueDate: null,
  dueTime: null,
  originalDateText: null,
  dateCertain: true,
  priority: 'NORMAL',
  actionRequired: true,
  confidence: 0.9,
  isForCurrentUser: true,
  entities: {},
  ...over,
});
const run = (messageText: string, items: any[], over: any = {}) =>
  serviceReturning({ items, updates: [] }).extractItemsWithTokens({
    messageText,
    senderName: 'Amit',
    currentUserName: 'Vaibhav',
    messageTimestamp: SENT,
    chatKind: 'direct',
    ...over,
  });

describe('all requested categories exist', () => {
  it('has a type for each of the 31 categories', () => {
    for (const t of [
      'TASK', 'REMINDER', 'MEETING', 'APPOINTMENT', 'FOLLOW_UP', 'DEADLINE', 'QUESTION', 'DECISION', 'CONTACT', 'PAYMENT', 'INVOICE',
      'ORDER', 'DOCUMENT', 'COMPLAINT', 'URGENT', 'REQUIREMENT', 'LEAD', 'NEGOTIATION', 'PROJECT_UPDATE', 'CHANGE', 'INSTRUCTION',
      'PREFERENCE', 'BUSINESS', 'TRAVEL', 'INTERVIEW', 'RECURRING', 'APPROVAL', 'RENEWAL', 'GOAL', 'SUMMARY', 'PENDING', 'WISH',
    ])
      expect(EXTRACTION_TYPES).toContain(t);
  });

  it('no longer produces the catch-all OTHER type', async () => {
    const r = await run('Some message here', [item('OTHER', 'Some message here')]);
    expect(r.items).toHaveLength(0);
  });
});

describe('each category is accepted when the message proves it', () => {
  const cases: [string, string, any?][] = [
    ['TASK', 'please prepare the client deck'],
    ['REMINDER', 'remind me to renew the domain'],
    ['FOLLOW_UP', 'call back the vendor about the quote'],
    ['QUESTION', 'can you share the final numbers?'],
    ['DECISION', 'we agreed that Priya owns the release'],
    ['CONTACT', 'his number is 9876543210, he is the CFO', { entities: { phones: ['9876543210'] } }],
    ['INVOICE', 'invoice 4471 is attached for last month'],
    ['ORDER', 'your order has shipped, tracking id TRK123'],
    ['DOCUMENT', 'attached the signed agreement pdf'],
    ['COMPLAINT', 'the app keeps crashing and it is a big problem'],
    ['URGENT', 'urgent: the server is down, fix asap'],
    ['REQUIREMENT', 'we need 200 units delivered in two batches'],
    ['LEAD', 'a client enquired about our premium plan'],
    ['NEGOTIATION', 'they are offering 45000 instead of 50000'],
    ['PROJECT_UPDATE', 'phase one milestone is complete, phase two starts next week'],
    ['CHANGE', 'the launch is postponed by one week'],
    ['INSTRUCTION', 'please note: always send the invoice before the call'],
    ['PREFERENCE', 'the customer prefers WhatsApp over email'],
    ['BUSINESS', 'our payment terms are net 30 days'],
    ['RECURRING', 'send the sales report every Monday'],
    ['APPROVAL', 'the budget was approved by finance'],
    ['GOAL', 'my goal is to finish the course by December'],
    ['PENDING', 'still waiting on the vendor reply for the sample'],
    ['WISH', 'Happy Diwali to you and your family'],
  ];
  it.each(cases.map(([t, e, o]) => [t, e, o ?? {}] as [string, string, any]))('%s', async (type, excerpt, over) => {
    const r = await run(excerpt, [item(type, excerpt, over)]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].extractionType).toBe(type);
  });

  it('PAYMENT needs an amount; INVOICE and ORDER do not', async () => {
    expect((await run('pay the rent soon', [item('PAYMENT', 'pay the rent soon')])).items).toHaveLength(0);
    expect((await run('pay Rs 5000 rent', [item('PAYMENT', 'pay Rs 5000 rent', { entities: { amounts: ['Rs 5000'] } })])).items).toHaveLength(1);
  });

  it('INTERVIEW and RENEWAL need a date or date wording', async () => {
    expect((await run('interview with the panel', [item('INTERVIEW', 'interview with the panel')])).items).toHaveLength(0);
    expect((await run('interview tomorrow at 11', [item('INTERVIEW', 'interview tomorrow at 11', { dueDate: '2026-10-16', dueTime: '11:00' })])).items).toHaveLength(1);
    expect((await run('licence expires 3 March', [item('RENEWAL', 'licence expires 3 March', { dueDate: '2027-03-03' })])).items).toHaveLength(1);
  });

  it('SUMMARY is only for long messages', async () => {
    expect((await run('short note about the plan', [item('SUMMARY', 'short note about the plan')])).items).toHaveLength(0);
    const long = 'Update from the vendor call: ' + 'the team agreed on scope, timeline and pricing, ' .repeat(8) + 'next steps are listed below.';
    expect(long.length).toBeGreaterThan(200);
    expect((await run(long, [item('SUMMARY', 'the team agreed on scope, timeline and pricing')])).items).toHaveLength(1);
  });

  it('a group wish is kept even though it is not addressed to the user', async () => {
    const r = await run('Happy Diwali everyone', [item('WISH', 'Happy Diwali everyone', { isForCurrentUser: false })], { groupName: 'MCA', chatKind: null });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].eventDate).toBe('2026-10-15');
  });

  it('other group items are still dropped unless they are for the user', async () => {
    const r = await run('they need 200 units', [item('REQUIREMENT', 'they need 200 units', { isForCurrentUser: false })], { groupName: 'Sales', chatKind: null });
    expect(r.items).toHaveLength(0);
  });

  it('still requires the exact words from the message', async () => {
    expect((await run('hello there', [item('COMPLAINT', 'a totally invented complaint')])).items).toHaveLength(0);
  });
});

describe('the signal gate lets the new categories through and keeps chat out', () => {
  const svc = serviceReturning({}) as any;
  const yes = [
    'invoice 4471 is attached, please pay by Friday',
    'your order has been delivered',
    'the client wants approval on the budget',
    'urgent: server is down',
    'complaint from the customer about the delay',
    'send the sales report every Monday',
    'licence will expire next month, please renew',
    'we agreed that Priya owns the release',
    'please note the new instructions',
    'quotation attached, they want a discount',
    'Happy Diwali to you and your family',
    'Congratulations on the new job!',
    'Happy Anniversary Rahul and Priya',
    'Get well soon, take rest',
  ];
  const no = ['kya kar raha hai', 'haha that was funny', 'ok bhai', 'lunch kal karuya ka', 'aaj mast din tha'];
  it.each(yes)('passes: %s', (t) => expect(svc.hasExtractionSignal(t)).toBe(true));
  it.each(no)('skips: %s', (t) => expect(svc.hasExtractionSignal(t)).toBe(false));

  it('promotions never pass, even with category words', () => {
    expect(svc.hasExtractionSignal('Loot offer: order now on https://www.amazon.in/dp/B0H')).toBe(false);
  });
  it('bulk scans accept wishes and the clearest business words', () => {
    expect(svc.hasStrongSignal('Happy Diwali to you and your family')).toBe(true);
    expect(svc.hasStrongSignal('urgent: server is down')).toBe(true);
    expect(svc.hasStrongSignal('please note the new instructions')).toBe(false);
  });
});

describe('keys stay stable across the new types', () => {
  it('the same excerpt and type give the same key', () => {
    expect(buildItemKey('INVOICE', 'Invoice 4471 attached')).toBe(buildItemKey('INVOICE', 'invoice 4471 attached!'));
    expect(buildItemKey('INVOICE', 'invoice 4471')).not.toBe(buildItemKey('ORDER', 'invoice 4471'));
  });
});

describe('casual call chat is not scanned', () => {
  const svc = serviceReturning({}) as any;
  it('skips chat that only mentions call', () => {
    for (const t of ['Call var tari bola', 'Diwas bhar mi call kele ek pan nahi recieve kela', 'Ghari gela ki call kr']) expect(svc.hasExtractionSignal(t)).toBe(false);
  });
  it('still scans calls with a time or a reminder', () => {
    for (const t of ['Call Rahul tomorrow at 10 AM', "Move Rahul's call to 11 AM", 'remind me to call John', 'call me at 5 baje']) expect(svc.hasExtractionSignal(t)).toBe(true);
  });
});

describe('casual call requests are not saved as tasks', () => {
  const task = (text: string, over: any = {}) => ({
    type: 'TASK', title: 'Call Vaibhav', description: 'x', supportingText: text, dueDate: null, dueTime: null, originalDateText: null,
    dateCertain: true, priority: 'NORMAL', actionRequired: true, confidence: 0.9, isForCurrentUser: true, entities: {}, ...over,
  });
  const run2 = (text: string, it: any) =>
    serviceReturning({ items: [it], updates: [] }).extractItemsWithTokens({
      messageText: text, senderName: 'Namrata', currentUserName: 'Vaibhav', messageTimestamp: new Date('2026-10-15T08:00:00Z'), chatKind: 'direct',
    });

  it('drops a short call request with no date or time', async () => {
    expect((await run2('Call var tari bola', task('Call var tari bola'))).items).toHaveLength(0);
    expect((await run2('call me', task('call me'))).items).toHaveLength(0);
  });
  it('keeps a call with a time', async () => {
    const r = await run2('call me tomorrow at 4 pm', task('call me tomorrow at 4 pm', { dueDate: '2026-10-16', dueTime: '16:00' }));
    expect(r.items).toHaveLength(1);
  });
  it('keeps a long, specific message that mentions a call', async () => {
    const text = 'Please call the vendor and confirm the delivery schedule for the new batch before we sign';
    expect((await run2(text, task(text))).items).toHaveLength(1);
  });
});

describe('relative dates just after midnight', () => {
  const promptFor = async (sentAt: string) => {
    let prompt = '';
    const svc: any = Object.create(AIService.prototype);
    svc.logger = { warn: () => {}, error: () => {} };
    svc.callGeminiWithTokens = async (p: string) => ((prompt = p), { text: '{"items":[],"updates":[]}', inputTokens: 1, outputTokens: 1 });
    await svc.extractItemsWithTokens({ messageText: 'your order will reach tomorrow', senderName: 'Amit', currentUserName: 'Vaibhav', messageTimestamp: new Date(sentAt), chatKind: 'direct' });
    return prompt;
  };
  it('at 12:24 AM India time tomorrow is counted from the previous day', async () => {
    const p = await promptFor('2026-10-16T18:54:14Z'); // 00:24 on 17 Oct in India
    expect(p).toContain('just after midnight');
    expect(p).toContain('ONLY from 2026-10-16');
  });
  it('during the day the sent day is used as is', async () => {
    const p = await promptFor('2026-10-16T08:00:00Z'); // 13:30 on 16 Oct
    expect(p).not.toContain('just after midnight');
    expect(p).toContain('ONLY from 2026-10-16');
  });
});

describe('messages the user sends', () => {
  const item = (text: string, over: any = {}) => ({
    type: 'TASK', title: 'Send proposal to Priya', description: 'x', supportingText: text, dueDate: '2026-10-16', dueTime: null,
    originalDateText: 'by Friday', dateCertain: true, priority: 'NORMAL', actionRequired: true, confidence: 0.92, isForCurrentUser: false, entities: {}, ...over,
  });
  const run3 = (text: string, it: any, extra: any = {}) =>
    serviceReturning({ items: [it], updates: [] }).extractItemsWithTokens({
      messageText: text, senderName: 'Amit', currentUserName: 'Vaibhav', messageTimestamp: new Date('2026-10-15T08:00:00Z'), fromMe: true, ...extra,
    });

  it('keeps the user\'s own commitment even in a group where it is not "addressed" to them', async () => {
    const t = 'I will send the proposal to Priya by Friday';
    const r = await run3(t, item(t), { groupName: 'Team', chatKind: null });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].isForCurrentUser).toBe(true);
  });
  it('does not save a birthday or festival wish the user sent', async () => {
    const t = 'Happy birthday Rahul';
    expect((await run3(t, item(t, { type: 'BIRTHDAY', birthdayPerson: 'Rahul' }))).items).toHaveLength(0);
    expect((await run3('Happy Diwali', item('Happy Diwali', { type: 'WISH' }))).items).toHaveLength(0);
  });
  it('tells the model the message was written by the user', async () => {
    let prompt = '';
    const svc: any = Object.create(AIService.prototype);
    svc.callGeminiWithTokens = async (p: string) => ((prompt = p), { text: '{"items":[],"updates":[]}', inputTokens: 1, outputTokens: 1 });
    await svc.extractItemsWithTokens({ messageText: 'call me at 5', senderName: 'Amit', currentUserName: 'Vaibhav', fromMe: true });
    expect(prompt).toContain('WRITTEN BY Vaibhav');
    await svc.extractItemsWithTokens({ messageText: 'call me at 5', senderName: 'Amit', currentUserName: 'Vaibhav' });
    expect(prompt).not.toContain('WRITTEN BY');
  });
});
