# Security Policy

## Supported versions

Only the latest published minor is supported. There are no LTS branches; this is a
pre-1.0 library and the API is still moving.

## Reporting a vulnerability

Please report security issues privately via GitHub's
["Report a vulnerability"](https://github.com/tsbouncer/tsbouncer/security/advisories/new)
on the Security tab of the repository. Do not open a public issue.

Include a description, the affected version, and a minimal reproduction if you have
one. You can expect an acknowledgement within a few days.

## Threat model

`tsbouncer` answers one question: *is this subject allowed to do this permission on
this resource, according to this model and this data?*

It deliberately does **not** handle authentication, identity verification, sessions,
tokens, or transport security. It is not an authorization server and holds no secrets.
Trusting the subject string passed to `check()` is the caller's responsibility.

The library **fails closed**. A condition that throws, a missing context key, an
unresolvable reference, or an exhausted evaluation budget all resolve to *not allowed*
rather than raising or returning a permissive result. Reports of any path that returns
allowed when it should return denied are treated as critical.

## Scope

In scope:

- a decision returning `allowed: true` when the model and data say otherwise
- a store or evaluator failing to enforce exclusion, wildcards, or conditions
- a crash or hang reachable from attacker-influenced model or tuple data

Out of scope:

- authorization *policy* you wrote incorrectly — the model is your business
- anything reachable only by modifying the caller's own code
- denial of service from deliberately enormous graphs (budgets exist to bound this,
  but v0.1 makes no hard guarantees about wall-clock time)
