import { describe, expect, it } from 'vitest';
import {
  AccessDeniedError,
  AuthorizationError,
  EvaluationLimitError,
  InvalidReferenceError,
  InvalidStoreError,
  isAuthorizationError,
  ModelDefinitionError,
  StoreError,
  TupleValidationError,
} from '../src/errors.js';

describe('AuthorizationError', () => {
  it('carries a code and is an Error', () => {
    const error = new AuthorizationError('store_error', 'boom');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('store_error');
    expect(error.message).toBe('boom');
    expect(error.name).toBe('AuthorizationError');
  });

  it('omits cause when none is given', () => {
    expect(new AuthorizationError('store_error', 'boom').cause).toBeUndefined();
  });

  it('forwards cause when given', () => {
    const cause = new Error('root');
    expect(new AuthorizationError('store_error', 'boom', { cause }).cause).toBe(cause);
  });

  it('leaves details undefined when omitted', () => {
    expect(new AuthorizationError('store_error', 'boom').details).toBeUndefined();
  });

  it('uses the subclass name', () => {
    expect(new StoreError('boom').name).toBe('StoreError');
    expect(
      new AccessDeniedError({
        subject: 'user:a',
        permission: 'doc.read',
        resource: 'doc:1',
      }).name,
    ).toBe('AccessDeniedError');
  });
});

describe('concrete error codes', () => {
  it.each([
    [new InvalidReferenceError('bad'), 'invalid_reference'],
    [new ModelDefinitionError('bad'), 'invalid_model'],
    [new TupleValidationError('bad'), 'invalid_tuple'],
    [new StoreError('bad'), 'store_error'],
    [new InvalidStoreError('bad'), 'invalid_store'],
    [new EvaluationLimitError('depth', 20), 'evaluation_limit'],
    [
      new AccessDeniedError({ subject: 'u', permission: 'p', resource: 'r' }),
      'access_denied',
    ],
  ])('assigns the right code to %s', (error, code) => {
    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error.code).toBe(code);
  });

  it('accepts details on every subclass', () => {
    expect(new InvalidReferenceError('bad', { input: 'x' }).details).toEqual({
      input: 'x',
    });
    expect(new ModelDefinitionError('bad', { type: 'doc' }).details).toEqual({
      type: 'doc',
    });
    expect(new TupleValidationError('bad', { tuple: 'x' }).details).toEqual({
      tuple: 'x',
    });
    expect(new InvalidStoreError('bad', { missing: 'read' }).details).toEqual({
      missing: 'read',
    });
  });

  it('accepts a cause on StoreError', () => {
    const cause = new Error('socket closed');
    expect(new StoreError('read failed', { cause }).cause).toBe(cause);
  });
});

describe('AccessDeniedError', () => {
  const request = {
    subject: 'user:alice',
    permission: 'document.read',
    resource: 'document:1',
  };

  it('names the subject, permission, and resource in the message', () => {
    expect(new AccessDeniedError(request).message).toBe(
      'user:alice is not allowed to document.read on document:1',
    );
  });

  it('freezes and copies the request', () => {
    const error = new AccessDeniedError(request);
    expect(error.request).toEqual(request);
    expect(Object.isFrozen(error.request)).toBe(true);
    expect(error.details).toEqual(request);
  });

  it('does not alias the caller object', () => {
    const mutable = { ...request };
    const error = new AccessDeniedError(mutable);
    mutable.subject = 'user:mallory';
    expect(error.request.subject).toBe('user:alice');
  });
});

describe('EvaluationLimitError', () => {
  it.each(['depth', 'nodes', 'deadline'] as const)(
    'records the %s limit and budget',
    (limit) => {
      const error = new EvaluationLimitError(limit, 42);
      expect(error.limit).toBe(limit);
      expect(error.budget).toBe(42);
      expect(error.message).toContain('42');
      expect(error.details).toEqual({ limit, budget: 42 });
    },
  );
});

describe('isAuthorizationError', () => {
  it('recognises every subclass', () => {
    expect(isAuthorizationError(new StoreError('x'))).toBe(true);
    expect(isAuthorizationError(new InvalidStoreError('x'))).toBe(true);
    expect(isAuthorizationError(new EvaluationLimitError('depth', 1))).toBe(true);
  });

  it('rejects foreign values', () => {
    expect(isAuthorizationError(new Error('x'))).toBe(false);
    expect(isAuthorizationError('nope')).toBe(false);
    expect(isAuthorizationError(null)).toBe(false);
    expect(isAuthorizationError({ code: 'store_error' })).toBe(false);
  });
});
