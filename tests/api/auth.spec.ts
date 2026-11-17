/** R3 behavior: sign-up, login, 2FA, and password changes keep accounts safe. */
import { test, expect, covers } from '../../src/fixtures';
import { Api, SECURITY_ANSWER, login, newCustomer, register, uniqueEmail } from '../../src/api';
import { customerWith2fa, freshTotp, loginWith2fa } from '../../src/shop';
import { SoftwarePasskey, registerPasskey, registrationBody, signInBody } from '../../src/passkey';

const PASSWORD = 'Valid-Passw0rd!';
const signUp = (email: string, extra: Record<string, unknown> = {}) => ({
  email, password: PASSWORD, passwordRepeat: PASSWORD, securityQuestion: { id: 1 }, securityAnswer: SECURITY_ANSWER, ...extra,
});
// The user record inside a JWT, to check what a session token reveals.
const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).data;

// Account creation: no self-granted roles, no duplicate or malformed accounts.
test.describe('R3 sign-up', () => {
  test('creates a customer account', covers('users.register', 'anonymous'), async ({ anonymous }) => {
    // Act
    const res = await anonymous.post('/api/Users', signUp(uniqueEmail()));

    // Assert
    expect(res.status()).toBe(201);
    expect((await res.json()).data.role).toBe('customer');
  });

  test('ignores a role sent with the sign-up form', covers('users.register', 'anonymous'), async ({ anonymous }) => {
    // Act
    const res = await anonymous.post('/api/Users', signUp(uniqueEmail(), { role: 'admin' }));

    // Assert
    expect([201, 400]).toContain(res.status());
    if (res.status() === 201) expect((await res.json()).data.role).toBe('customer');
  });

  test('rejects an email that is already registered', covers('users.register', 'anonymous'), async ({ anonymous, request }) => {
    // Arrange
    const { email } = await register(request);

    // Act
    const res = await anonymous.post('/api/Users', signUp(email));

    // Assert
    expect(res.status()).toBe(400);
  });

  test('rejects passwords that do not match', covers('users.register', 'anonymous'), async ({ anonymous }) => {
    // Act
    const res = await anonymous.post('/api/Users', signUp(uniqueEmail(), { passwordRepeat: 'Different-1!' }));

    // Assert
    expect(res.status()).toBe(400);
  });

  test('rejects an empty email', covers('users.register', 'anonymous'), async ({ anonymous }) => {
    // Act
    const res = await anonymous.post('/api/Users', signUp(''));

    // Assert
    expect(res.status()).toBe(400);
  });
});

// Account takeover routes: guessing, SQL injection, forged or unsigned tokens, data in the token.
test.describe('R3 login', () => {
  test('returns a session for the right password', covers('auth.login', 'anonymous'), async ({ request }) => {
    // Arrange
    const { email, password } = await register(request);

    // Act
    const res = await request.post('/rest/user/login', { data: { email, password } });

    // Assert
    expect(res.status()).toBe(200);
    expect(claims((await res.json()).authentication.token).email).toBe(email);
  });

  test('the session token does not carry the password hash', covers('auth.login', 'customer'), async ({ customer }) => {
    // Assert
    expect(claims(customer.account!.token)).not.toHaveProperty('password');
  });

  test('gives the same answer for a wrong password and an unknown email', covers('auth.login', 'anonymous'), async ({ request }) => {
    // Arrange
    const { email } = await register(request);

    // Act
    const wrongPassword = await request.post('/rest/user/login', { data: { email, password: 'nope' } });
    const unknownEmail = await request.post('/rest/user/login', { data: { email: uniqueEmail(), password: 'nope' } });

    // Assert
    expect(wrongPassword.status()).toBe(401);
    expect(unknownEmail.status()).toBe(401);
    expect(await wrongPassword.text()).toBe(await unknownEmail.text());
  });

  test('is not fooled by SQL in the email field', covers('auth.login', 'anonymous'), async ({ request }) => {
    // Act
    const res = await request.post('/rest/user/login', { data: { email: "' OR 1=1--", password: 'x' } });

    // Assert
    expect(res.status()).toBe(401);
  });

  test('slows down repeated wrong passwords for one account', covers('auth.login', 'anonymous'), async ({ request }) => {
    // Arrange
    const { email } = await register(request);

    // Act
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      statuses.push((await request.post('/rest/user/login', { data: { email, password: `guess-${i}` } })).status());
    }

    // Assert
    expect(statuses, 'expected a 429 within 20 wrong attempts').toContain(429);
  });

  test('rejects a session token that is not signed', covers('basket.get', 'anonymous'), async ({ customer, request }) => {
    // Arrange: same claims, "alg": "none", no signature
    const [, payload] = customer.account!.token.split('.');
    const unsigned = `${Buffer.from('{"typ":"JWT","alg":"none"}').toString('base64url')}.${payload}.`;

    // Act
    const res = await request.get(`/rest/basket/${customer.account!.basketId}`, { headers: { Authorization: `Bearer ${unsigned}` } });

    // Assert
    expect(res.status()).toBe(401);
  });

  test('records the login IP without returning the password hash', covers('auth.saveLoginIp', 'customer'), async ({ customer }) => {
    // Act
    const res = await customer.get('/rest/saveLoginIp');

    // Assert
    expect(res.status()).toBe(200);
    expect(await res.json()).not.toHaveProperty('password');
  });

});

// Passkeys, signed by a software authenticator (src/passkey.ts) so Juice Shop's own verification runs.
test.describe('R3 passkeys', () => {
  test('a customer signs in with their registered passkey', covers('passkey.loginVerify', 'customer'), async ({ customer, anonymous }) => {
    // Arrange
    const passkey = await registerPasskey(customer);

    // Act
    const res = await anonymous.post('/rest/passkey/login-verify', await signInBody(anonymous, passkey));

    // Assert
    expect(res.status()).toBe(200);
    expect((await res.json()).authentication.umail).toBe(customer.account!.email);
  });

  test('a passkey nobody registered is refused', covers('passkey.loginVerify', 'anonymous'), async ({ anonymous }) => {
    // Act
    const res = await anonymous.post('/rest/passkey/login-verify', await signInBody(anonymous, new SoftwarePasskey()));

    // Assert
    expect(res.status()).toBe(401);
  });

  // Account takeover: credential ids are not secret, so the signature is the only proof of the key.
  test('a sign-in signed by the wrong key is refused', covers('passkey.loginVerify', 'anonymous'), async ({ customer, anonymous }) => {
    // Arrange
    const victims = await registerPasskey(customer);

    // Act
    const res = await anonymous.post('/rest/passkey/login-verify', await signInBody(anonymous, victims, 'another key'));

    // Assert
    expect(res.status(), `login-verify with a bad signature for ${customer.account!.email}'s passkey returned ${res.status()}`).toBe(401);
  });

  // WebAuthn says a credential id registered to one account must not be registered again by another.
  test("another customer's credential id cannot be registered again", covers('passkey.registerVerify', 'customer'), async ({ customer, request }) => {
    // Arrange
    const victims = await registerPasskey(customer);
    const attacker = new Api(request, await newCustomer(request));
    const sameId = new SoftwarePasskey(victims.rawId);

    // Act
    const res = await attacker.post('/rest/passkey/register-verify', await registrationBody(attacker, sameId));

    // Assert
    expect(res.ok(), `re-registering another account's credential id returned ${res.status()}`).toBe(false);
  });
});

// 2FA must actually be required once on, and only the right code gets through.
test.describe('R3 two-factor authentication', () => {
  test('after setup, the password alone does not log in', covers('2fa.setup', 'customer'), async ({ request }) => {
    // Arrange
    const acct = await customerWith2fa(request);

    // Act
    const res = await request.post('/rest/user/login', { data: { email: acct.email, password: acct.password } });

    // Assert
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.status).toBe('totp_token_required');
    expect(body).not.toHaveProperty('authentication');
  });

  test('the password plus the current code logs in', covers('2fa.verify', 'anonymous'), async ({ request }) => {
    // Arrange
    const acct = await customerWith2fa(request);

    // Act
    const session = await loginWith2fa(request, acct);

    // Assert
    expect(claims(session.token).email).toBe(acct.email);
  });

  test('a wrong code is rejected', covers('2fa.verify', 'anonymous'), async ({ request }) => {
    // Arrange
    const acct = await customerWith2fa(request);
    const first = await request.post('/rest/user/login', { data: { email: acct.email, password: acct.password } });
    const { tmpToken } = (await first.json()).data;

    // Act
    const res = await request.post('/rest/2fa/verify', { data: { tmpToken, totpToken: '000000' } });

    // Assert
    expect(res.status()).toBe(401);
  });

  test('setup fails with the wrong password', covers('2fa.setup', 'customer'), async ({ customer }) => {
    // Arrange
    const status = await (await customer.get('/rest/2fa/status')).json();

    // Act
    const res = await customer.post('/rest/2fa/setup', {
      password: 'wrong', setupToken: status.setupToken, initialToken: await freshTotp(status.secret),
    });

    // Assert
    expect(res.status()).toBe(401);
    expect((await (await customer.get('/rest/2fa/status')).json()).setup).toBe(false);
  });

  test('disable needs the password, then login no longer asks for a code', covers('2fa.disable', 'customer'), async ({ request }) => {
    // Arrange
    const acct = await customerWith2fa(request);

    // Act
    const wrong = await acct.api.post('/rest/2fa/disable', { password: 'wrong' });
    const right = await acct.api.post('/rest/2fa/disable', { password: acct.password });

    // Assert
    expect(wrong.status()).toBe(401);
    expect(right.status()).toBe(200);
    await expect(login(request, acct.email, acct.password)).resolves.toMatchObject({ email: acct.email });
  });

  test('status reports whether 2FA is on', covers('2fa.status', 'customer'), async ({ request }) => {
    // Arrange
    const acct = await customerWith2fa(request);
    const session = new Api(request, await loginWith2fa(request, acct));

    // Act
    const status = await (await session.get('/rest/2fa/status')).json();

    // Assert
    expect(status).toEqual({ setup: true });
  });
});

// Changing and resetting passwords: each path must prove it's the account owner.
test.describe('R3 passwords', () => {
  // change-password is a GET with the passwords in the query string; here `current` is left out entirely.
  test('changing the password requires the current password', covers('password.change', 'customer'), async ({ customer }) => {
    // Act
    const res = await customer.get('/rest/user/change-password?new=Another-Passw0rd!&repeat=Another-Passw0rd!');

    // Assert
    expect(res.status()).toBe(401);
  });

  test('a changed password works and the old one stops working', covers('password.change', 'customer'), async ({ customer, request }) => {
    // Arrange
    const next = 'Another-Passw0rd!';
    const q = new URLSearchParams({ current: customer.account!.password, new: next, repeat: next });

    // Act
    const res = await customer.get(`/rest/user/change-password?${q}`);

    // Assert
    expect(res.status()).toBe(200);
    expect(await res.text()).not.toMatch(/"password"/);
    await expect(login(request, customer.account!.email, next)).resolves.toBeTruthy();
    await expect(login(request, customer.account!.email, customer.account!.password)).rejects.toThrow(/401/);
  });

  test('changing the password is refused without a session', covers('password.change', 'anonymous'), async ({ anonymous }) => {
    // Act
    const res = await anonymous.get('/rest/user/change-password?current=x&new=y&repeat=y');

    // Assert
    expect(res.status()).toBe(401);
  });

  test('reset with the right security answer sets a new password', covers('password.reset', 'anonymous'), async ({ request }) => {
    // Arrange
    const { email } = await register(request);

    // Act
    const res = await request.post('/rest/user/reset-password', { data: { email, answer: SECURITY_ANSWER, new: 'Reset-Passw0rd!', repeat: 'Reset-Passw0rd!' } });

    // Assert
    expect(res.status()).toBe(200);
    expect(await res.text()).not.toMatch(/"password"/);
    await expect(login(request, email, 'Reset-Passw0rd!')).resolves.toBeTruthy();
  });

  test('reset with a wrong security answer changes nothing', covers('password.reset', 'anonymous'), async ({ request }) => {
    // Arrange
    const { email, password } = await register(request);

    // Act
    const res = await request.post('/rest/user/reset-password', { data: { email, answer: 'wrong', new: 'Reset-Passw0rd!', repeat: 'Reset-Passw0rd!' } });

    // Assert
    expect(res.status()).toBe(401);
    await expect(login(request, email, password)).resolves.toBeTruthy();
  });

  test('the security question for an email is shown without a session', covers('securityQuestion.forEmail', 'anonymous'), async ({ request }) => {
    // Arrange
    const { email } = await register(request);

    // Act
    const res = await request.get(`/rest/user/security-question?email=${encodeURIComponent(email)}`);

    // Assert
    expect((await res.json()).question.id).toBe(1);
  });

  test('a security answer cannot be replaced for an existing account', covers('securityAnswers.create', 'anonymous'), async ({ request }) => {
    // Arrange
    const { id } = await register(request);

    // Act
    const res = await request.post('/api/SecurityAnswers', { data: { UserId: id, answer: 'attacker', SecurityQuestionId: 2 } });

    // Assert
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });
});
