<#--
  The one-time code step for a privileged person (ADR-0019 · SEC-03), inside the OB-18 frame. Keycloak's contract is
  kept: form id kc-otp-login-form posting to url.loginAction, the code in field `otp`, and `selectedCredentialId` when
  the person has more than one phone registered.
-->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('totp'); section>
<#if section = "header">
${msg("doLogIn")}
<#elseif section = "form">
<form id="kc-otp-login-form" class="${properties.kcFormClass!}" action="${url.loginAction}" method="post">
<#if otpLogin.userOtpCredentials?size gt 1>
<fieldset class="sre-otp-choices">
<legend class="sre-label">${msg("loginTotpDeviceName")}</legend>
<#list otpLogin.userOtpCredentials as otpCredential>
<input id="kc-otp-credential-${otpCredential?index}" class="${properties.kcLoginOTPListInputClass!}" type="radio" name="selectedCredentialId" value="${otpCredential.id}"<#if otpCredential.id == otpLogin.selectedCredentialId> checked</#if>>
<label for="kc-otp-credential-${otpCredential?index}" class="${properties.kcLoginOTPListClass!}">${otpCredential.userLabel}</label>
</#list>
</fieldset>
</#if>
<div class="sl-field">
<label for="otp">${msg("loginOtpOneTime")}</label>
<div class="sl-input-wrap"><@layout.icon "lock"/><input id="otp" name="otp" type="text" inputmode="numeric" autocomplete="one-time-code" autofocus aria-describedby="sl-form-message"<#if messagesPerField.existsError('totp')> aria-invalid="true"</#if>></div>
</div>
<#if messagesPerField.existsError('totp')>
<div id="sl-form-message" class="sl-message" role="alert" data-tone="red">${kcSanitize(messagesPerField.get('totp'))?no_esc}</div>
<#else>
<div id="sl-form-message" class="sl-message" role="status" aria-live="polite" hidden></div>
</#if>
<button id="kc-login" class="sl-submit" name="login" type="submit"><span>${msg("doLogIn")}</span><@layout.icon "arrow"/></button>
</form>
</#if>
</@layout.registrationLayout>
