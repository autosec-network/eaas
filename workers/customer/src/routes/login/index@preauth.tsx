import { $, component$, useSignal, useVisibleTask$ } from '@builder.io/qwik';
import { LuKeyRound, LuMail } from '@qwikest/icons/lucide';
import { browserSupportsWebAuthnAutofill, startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/types';
import * as zm from 'zod/mini';
import { turnstileVerify } from '~/helpers/turnstile';
import { useTurnstileKey } from '~/routes/layout-preauth';
import { useSignIn } from '~/routes/plugin@auth';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore this gets generated automatically later in the build process
import * as m from '~/paraglide/messages';

/**
 * Performs the client-side WebAuthn flow that `useSignIn` cannot handle.
 *
 * Note: `@auth/qwik` always disables CSRF checks (`skipCSRFCheck`), so `/auth/csrf` intentionally returns 404. No CSRF token is needed for the callback POST (qwik natively does CSRF with SSR)
 * @link https://qwik.dev/docs/deployments/node/#csrf-protection
 *
 * 1. Fetches WebAuthn challenge options from `/auth/webauthn-options/passkey`
 * 2. Calls the browser WebAuthn API via `@simplewebauthn/browser`
 * 3. Submits the credential response to `/auth/callback/passkey` via a hidden form POST so the browser follows the redirect chain naturally.
 *
 * @param useConditionalUI - If true, uses conditional mediation (passkey autofill). The browser will show passkey suggestions without user clicking a button.
 */
async function passkeyFlow(useConditionalUI = false) {
	// Fetch WebAuthn options from the Auth.js endpoint (no email = authenticate)
	// This also sets a challenge cookie required for callback verification
	const optionsUrl = new URL('/auth/webauthn-options/passkey', window.location.origin);

	const optionsRes = await fetch(optionsUrl);
	if (!optionsRes.ok) {
		const body = await optionsRes.text().catch(() => '');
		throw new Error(`Failed to fetch WebAuthn options (${optionsRes.status}): ${body || optionsRes.statusText}`);
	}

	const { options } = await optionsRes.json<{ options: PublicKeyCredentialRequestOptionsJSON }>();

	// Invoke the browser WebAuthn API (authenticate only)
	const credential = await startAuthentication(options, useConditionalUI);

	// Submit via a hidden form POST so the browser follows Auth.js redirects
	const form = document.createElement('form');
	form.method = 'POST';
	form.action = '/auth/callback/passkey';
	form.style.display = 'none';

	for (const [name, value] of Object.entries({
		action: 'authenticate',
		data: JSON.stringify(credential),
		callbackUrl: '/',
	})) {
		const input = document.createElement('input');
		input.type = 'hidden';
		input.name = name;
		input.value = value;
		form.appendChild(input);
	}

	document.body.appendChild(form);
	form.submit();
}

export default component$(() => {
	const showLogin = useSignal<boolean>(false);

	const emailFieldDebouncer = useSignal<number>();
	const emailField = useSignal<HTMLInputElement>();
	const emailValid = useSignal<boolean>(false);
	const emailLoading = useSignal<boolean>(false);
	const emailSent = useSignal<boolean>(false);
	const emailError = useSignal<string>();

	// eslint-disable-next-line qwik/no-use-visible-task, @typescript-eslint/unbound-method
	useVisibleTask$(({ track, cleanup }) => {
		track(() => emailField.value);

		const onInput = () => {
			window.clearTimeout(emailFieldDebouncer.value);
			emailFieldDebouncer.value = window.setTimeout(() => {
				emailValid.value = zm.email({ pattern: zm.regexes.idnEmail }).check(zm.trim()).safeParse(emailField.value?.value).success;
			}, 300);
		};

		emailField.value?.addEventListener('input', onInput);

		cleanup(() => clearTimeout(emailFieldDebouncer.value));
		cleanup(() => emailField.value?.removeEventListener('input', onInput));
	});

	const passkeyLoading = useSignal<boolean>(false);
	const passkeyError = useSignal<string>();

	const turnstileSiteKey = useTurnstileKey();
	const turnstileWidget = useSignal<HTMLDivElement>();

	// eslint-disable-next-line qwik/no-use-visible-task, @typescript-eslint/unbound-method
	useVisibleTask$(({ track, cleanup }) => {
		track(() => turnstileWidget.value);
		track(() => window.turnstile);

		if (turnstileWidget.value && window.turnstile) {
			window.turnstile.render(turnstileWidget.value, {
				sitekey: turnstileSiteKey.value,
				action: 'login',
				callback: () => (showLogin.value = true),
				'expired-callback': () => (showLogin.value = false),
				'error-callback': () => {
					showLogin.value = false;
					return false;
				},
			});
		}

		cleanup(() => {
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
			if (window.turnstile) window.turnstile.remove(turnstileWidget.value);
		});
	});

	// eslint-disable-next-line qwik/no-use-visible-task
	useVisibleTask$(async ({ track }) => {
		track(() => showLogin.value);

		if (showLogin.value) {
			const supported = await browserSupportsWebAuthnAutofill().catch((error) => {
				console.error('Conditional UI check failed:', error);
				return false;
			});

			if (supported) {
				return passkeyFlow(true).catch((error: Error) => {
					// NotAllowedError is expected when user dismisses or uses the button instead
					if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') {
						console.error('Conditional UI error:', error);
					}
				});
			}
		}
	});

	const turnstileCheck = $(async () => {
		const response = await turnstileVerify(window.turnstile.getResponse(turnstileWidget.value));
		console.log('turnstileCheck', response);

		if (response.success) {
			return true as const;
		} else {
			// Always needs to be reset after consuming response
			window.turnstile.reset(turnstileWidget.value);
			return response['error-codes'];
		}
	});

	const signIn = useSignIn();

	return (
		<>
			<script async defer src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"></script>
			<div class="flex min-h-[60vh] items-center justify-center px-4">
				<div class="w-full max-w-sm">
					<div class="border-surface-light/60 shadow-primary-accent/5 dark:border-surface-dark/60 dark:bg-surface-dark/70 rounded-2xl border bg-white/70 p-8 shadow-xl backdrop-blur-md">
						<div class="mb-8 text-center">
							<h1 class="text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">{m.login_page_title()}</h1>
							<p class="mt-1.5 text-sm text-gray-500 dark:text-gray-400">{m.login_page_subtitle()}</p>
						</div>

						{showLogin.value ? (
							<div class="space-y-3">
								{/* Hidden input enables conditional UI (passkey autofill) in supporting browsers */}
								<input type="hidden" autoComplete="webauthn" />

								{/* Email magic link */}
								{emailSent.value ? (
									<div class="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-800 dark:bg-green-900/30 dark:text-green-300">{m.login_email_sent()}</div>
								) : (
									<>
										{emailError.value ? <div class="mb-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300">{emailError.value}</div> : null}
										<div class="flex gap-2">
											<input
												//
												ref={emailField}
												type="email"
												name="email"
												autoComplete="email webauthn"
												placeholder={m.login_email_placeholder()}
												disabled={emailLoading.value}
												class="focus:border-primary-accent focus:ring-primary-accent flex-1 rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 placeholder-gray-500 outline-none focus:ring-1 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-white dark:placeholder-gray-400"
											/>
											<button
												type="button"
												disabled={emailLoading.value || !emailValid.value}
												class="bg-primary-accent hover:bg-primary-accent/85 hover:shadow-primary-accent/25 flex cursor-pointer items-center justify-center rounded-xl px-4 py-3 text-white transition-all duration-150 hover:shadow-md active:scale-[0.98] disabled:cursor-wait disabled:opacity-60"
												onClick$={$(async (event: Event) => {
													event.preventDefault();
													event.stopPropagation();

													const validatedEmail = await zm.email({ pattern: zm.regexes.idnEmail }).check(zm.trim()).safeParseAsync(emailField.value?.value);

													if (validatedEmail.success) {
														try {
															const successOrErrors = await turnstileCheck();
															if (typeof successOrErrors === 'boolean') {
																emailLoading.value = true;
																emailError.value = undefined;

																await signIn.submit({ providerId: 'email', options: { email: validatedEmail.data, callbackUrl: '/' } });
																emailSent.value = true;
															} else if (Array.isArray(successOrErrors)) {
																console.error(new AggregateError(successOrErrors.map((e) => new Error(e))));
															}
														} catch (error) {
															emailLoading.value = false;
															emailError.value = error instanceof Error ? error.message : m.login_email_failed();
															console.error('Email sign in error:', error);
														}
													} else {
														emailLoading.value = false;
														emailError.value = m.login_email_invalid();
														console.error('Email validation failed:', zm.prettifyError(validatedEmail.error));
													}
												})}>
												<LuMail class="h-5 w-5" />
											</button>
										</div>
									</>
								)}

								{/* Divider */}
								<div class="my-1 flex items-center gap-3">
									<div class="h-px flex-1 bg-gray-200 dark:bg-gray-700"></div>
									<span class="text-xs text-gray-400 dark:text-gray-500">{m.login_or()}</span>
									<div class="h-px flex-1 bg-gray-200 dark:bg-gray-700"></div>
								</div>

								{passkeyError.value ? <div class="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300">{passkeyError.value}</div> : null}
								<button
									type="button"
									disabled={passkeyLoading.value}
									class="bg-primary-accent hover:bg-primary-accent/85 hover:shadow-primary-accent/25 flex w-full cursor-pointer items-center justify-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-white transition-all duration-150 hover:shadow-md active:scale-[0.98] disabled:cursor-wait disabled:opacity-60"
									onClick$={$(async (event: Event) => {
										event.preventDefault();
										event.stopPropagation();
										event.stopImmediatePropagation();

										try {
											const successOrErrors = await turnstileCheck();
											console.log('successOrErrors', successOrErrors);

											if (typeof successOrErrors === 'boolean') {
												passkeyLoading.value = true;
												passkeyError.value = undefined;

												return passkeyFlow().catch((error: Error) => {
													passkeyLoading.value = false;
													if (error.name === 'NotAllowedError') {
														passkeyError.value = m.login_passkey_cancelled();
													} else {
														passkeyError.value = error.message || m.login_passkey_failed();
														console.error('Passkey flow error:', error);
													}
												});
											} else if (Array.isArray(successOrErrors)) {
												console.error(new AggregateError(successOrErrors.map((error) => new Error(error))));
											} else {
												console.error('Unexpected Turnstile response:', successOrErrors);
											}
										} catch (error) {
											console.error('Sign in error:', error);
										}
									})}>
									<LuKeyRound class="h-5 w-5" />
									{passkeyLoading.value ? m.login_passkey_loading() : m.login_passkey_cta()}
								</button>
							</div>
						) : null}

						<div class="relative z-0 mx-auto mt-6 h-[65px] w-[300px]" ref={turnstileWidget}></div>
					</div>
					<footer class="mt-6 text-center text-xs text-gray-400 dark:text-gray-500">{m.login_page_footer()}</footer>
				</div>
			</div>
		</>
	);
});
