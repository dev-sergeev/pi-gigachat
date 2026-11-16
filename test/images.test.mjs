import { ConnectionStore, createConnectionProvider } from '../dist/connections.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ask, completion, json, user, withServer } from './helpers.mjs';

test('uploads an images and sends its ID in the cath request', async () => {
    await withServer(
        async ({ model, requests, baseUrl }) => {
            const image = {
                type: 'image',
                mimeType: 'image/png',
                data: Buffer.from('test image bytes').toString('base64'),
            };

            const result = await ask(
                { ...model, input: ['text', 'image'] },
                {
                    messages: [
                        user([
                            { type: 'text', text: 'Что на картинке?' },
                            image,
                        ]),
                    ],
                },
                {
                    maxRetries: 0,
                    env: {
                        GIGACHAT_BASE_URL: baseUrl,
                        GIGACHAT_STREAM: 'false',
                        GIGACHAT_EXTRA_BODY: '{}',
                    },
                },
            );

            assert.equal(result.stopReason, 'stop', result.errorMessage);
            assert.equal(requests.length, 2);
            assert.equal(requests[0].url, '/v1/files');
            assert.match(
                requests[0].headers['content-type'],
                /^multipart\/form-data; boundary=/,
            );
            assert.match(requests[0].body, /name="purpose"\r\n\r\ngeneral/);
            assert.match(requests[0].body, /name="file"; filename="image.png"/);
            assert.match(requests[0].body, /Content-Type: image\/png/); 
            assert.match(requests[0].body, /test image bytes/);

            assert.equal(requests[1].url, '/v1/chat/completions');

            const message = requests[1].body.messages.find(
                (item) => item.role === 'user',
            );

            assert.equal(message.content, 'Что на картинке?');
            assert.deepEqual(message.attachments, ['test-file-id']);
        },
        (request, response) => {
            if (request.url === '/v1/files') {
                return json(response, { id: 'test-file-id' });
            }

            return json(response, completion());
        },
    );
});


test('does not request completion when image upload fails', async () => {
  await withServer(
    async ({ model, requests, baseUrl }) => {
      const image = {
        type: 'image',
        mimeType: 'image/png',
        data: Buffer.from('test image bytes').toString('base64'),
      };

      const result = await ask(
        { ...model, input: ['text', 'image'] },
        {
          messages: [
            user([
              { type: 'text', text: 'Что на картинке?' },
              image,
            ]),
          ],
        },
        {
          maxRetries: 0,
          env: {
            GIGACHAT_BASE_URL: baseUrl,
            GIGACHAT_STREAM: 'false',
            GIGACHAT_EXTRA_BODY: '{}',
          },
        },
      );

      assert.equal(result.stopReason, 'error');
      assert.match(result.errorMessage, /401/);

      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, '/v1/files');
    },
    (_request, response) => {
      return json(response, { message: 'Unauthorized' }, 401);
    },
  );
});

test('rejects two images in one user message before uploading', async () => {
  await withServer(async ({ model, requests, baseUrl }) => {
    const firstImage = {
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from('first image').toString('base64'),
    };

    const secondImage = {
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from('second image').toString('base64'),
    };

    const result = await ask(
      { ...model, input: ['text', 'image'] },
      {
        messages: [
          user([
            { type: 'text', text: 'Сравни картинки' },
            firstImage,
            secondImage,
          ]),
        ],
      },
      {
        maxRetries: 0,
        env: {
          GIGACHAT_BASE_URL: baseUrl,
          GIGACHAT_STREAM: 'false',
          GIGACHAT_EXTRA_BODY: '{}',
        },
      },
    );

    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage, /one image per message/);
    assert.equal(requests.length, 0);
  });
});

test('sends each image ID with its own user message', async () => {
  let uploadCount = 0;

  await withServer(
    async ({ model, requests, baseUrl }) => {
      const firstImage = {
        type: 'image',
        mimeType: 'image/png',
        data: Buffer.from('first image').toString('base64'),
      };

      const secondImage = {
        type: 'image',
        mimeType: 'image/jpeg',
        data: Buffer.from('second image').toString('base64'),
      };

      const result = await ask(
        { ...model, input: ['text', 'image'] },
        {
          messages: [
            user([{ type: 'text', text: 'Первая' }, firstImage]),
            user([{ type: 'text', text: 'Вторая' }, secondImage]),
          ],
        },
        {
          maxRetries: 0,
          env: {
            GIGACHAT_BASE_URL: baseUrl,
            GIGACHAT_STREAM: 'false',
            GIGACHAT_EXTRA_BODY: '{}',
          },
        },
      );

      assert.equal(result.stopReason, 'stop', result.errorMessage);
      assert.equal(requests.length, 3);

      assert.equal(requests[0].url, '/v1/files');
      assert.equal(requests[1].url, '/v1/files');
      assert.equal(requests[2].url, '/v1/chat/completions');

      const messages = requests[2].body.messages.filter(
        (message) => message.role === 'user',
      );

      assert.equal(messages.length, 2);
      assert.equal(messages[0].content, 'Первая');
      assert.deepEqual(messages[0].attachments, ['file-1']);
      assert.equal(messages[1].content, 'Вторая');
      assert.deepEqual(messages[1].attachments, ['file-2']);
    },
    (request, response) => {
      if (request.url === '/v1/files') {
        uploadCount += 1;
        return json(response, { id: `file-${uploadCount}` });
      }

      return json(response, completion());
    },
  );
});

test('sends a text-only message without uploading a file', async () => {
  await withServer(async ({ model, requests, baseUrl }) => {
    const result = await ask(
      { ...model, input: ['text', 'image'] },
      {
        messages: [
          user('Привет!'),
        ],
      },
      {
        maxRetries: 0,
        env: {
          GIGACHAT_BASE_URL: baseUrl,
          GIGACHAT_STREAM: 'false',
          GIGACHAT_EXTRA_BODY: '{}',
        },
      },
    );

    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/v1/chat/completions');

    const message = requests[0].body.messages.find(
      (item) => item.role === 'user',
    );

    assert.equal(message.content, 'Привет!');
    assert.equal(message.attachments, undefined);
  });
});

test('advertises image input for GigaChat-2-Pro on V1', () => {
  const models = [
    {
      id: 'GigaChat-2-Pro',
      name: 'GigaChat 2 Pro',
      contextWindow: 32000,
      maxTokens: 1000,
      reasoning: false,
    },
    {
      id: 'text-model',
      name: 'Text model',
      contextWindow: 32000,
      maxTokens: 1000,
      reasoning: false,
    },
  ];

  for (const protocol of ['v1', 'v2', 'openai']) {
    const connection = {
      id: `gigachat-test-${protocol}`,
      revision: 'test-revision',
      name: `Test ${protocol}`,
      baseUrl: 'https://example.invalid/v1',
      protocol,
      authorization: { type: 'token' },
      models,
    };

    const provider = createConnectionProvider(
      connection,
      new ConnectionStore(),
    );

    const pro = provider.getModels().find(
      (model) => model.id === 'GigaChat-2-Pro',
    );

    const text = provider.getModels().find(
      (model) => model.id === 'text-model',
    );

    assert.deepEqual(
      pro.input,
      protocol === 'v1' ? ['text', 'image'] : ['text'],
    );

    assert.deepEqual(text.input, ['text']);
  }
});