'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatError, sendError } = require('../lib/errors');

test('errors: formatError produces standardized error structure', () => {
  const err = formatError('Service temporarily unavailable', 503, 'req-uuid-123', {
    extraDetail: 'no backends',
  });

  assert.equal(err.error, 'Service temporarily unavailable');
  assert.equal(err.status, 503);
  assert.equal(err.requestId, 'req-uuid-123');
  assert.ok(err.timestamp, 'timestamp must exist');
  assert.equal(err.extraDetail, 'no backends');
});

test('errors: sendError transmits JSON and sets status code', () => {
  let capturedStatus = null;
  let capturedJson = null;

  const mockRes = {
    headersSent: false,
    status(code) {
      capturedStatus = code;
      return this;
    },
    json(data) {
      capturedJson = data;
      return this;
    },
  };

  sendError(mockRes, 401, 'Unauthorised', 'req-401', { hint: 'Provide key' });

  assert.equal(capturedStatus, 401);
  assert.equal(capturedJson.status, 401);
  assert.equal(capturedJson.error, 'Unauthorised');
  assert.equal(capturedJson.requestId, 'req-401');
  assert.equal(capturedJson.hint, 'Provide key');
});
