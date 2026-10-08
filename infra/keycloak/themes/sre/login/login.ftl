<#--
  The sign-in card (OB-18): the design's heading, subtitle and context box, labelled inputs with their icons, show/hide
  password, the Caps Lock hint, ONE primary "Sign in". The form works with no script (Enter submits, `required` holds);
  resources/js/sre-login.js adds the design's own required-field messages, show/hide, Caps Lock and the
  pending-submit guard. Keycloak's contract is kept: form id kc-form-login posting to url.loginAction, fields
  `username` and `password`. No remember-me, no forgot-password link, no role selector.
-->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username','password') displayInfo=false; section>
<#if section = "header">
${msg("loginAccountTitle")}
<#elseif section = "sre-lead">
<p class="sl-subtitle">${msg("sre.subtitle")}</p>
<div class="sl-store">
<@layout.icon "store"/>
<div><strong id="sl-context-name">${msg("sre.onlineContext")}</strong><small id="sl-context-sub">${msg("sre.onlineSub")}</small></div>
<span class="sl-mode" id="sl-context-mode">${msg("sre.cloud")}</span>
</div>
<#elseif section = "form">
<#if realm.password>
<#assign failed = messagesPerField.existsError('username','password')>
<form id="kc-form-login" action="${url.loginAction}" method="post"
 data-required-id="${msg("sre.requiredId")}" data-required-password="${msg("sre.requiredPassword")}" data-signing-in="${msg("sre.signingIn")}">
<#if !usernameHidden??>
<div class="sl-field">
<label for="username"><#if !realm.loginWithEmailAllowed>${msg("username")}<#elseif !realm.registrationEmailAsUsername>${msg("usernameOrEmail")}<#else>${msg("email")}</#if></label>
<div class="sl-input-wrap"><@layout.icon "user"/><input id="username" name="username" type="text" value="${(login.username!'')}" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="${msg("sre.idPlaceholder")}" aria-describedby="sl-form-message" required<#if failed> aria-invalid="true"</#if>></div>
</div>
</#if>
<div class="sl-field">
<label for="password">${msg("password")}</label>
<div class="sl-input-wrap"><@layout.icon "lock"/><input id="password" name="password" class="sl-password" type="password" autocomplete="current-password" placeholder="${msg("sre.passwordPlaceholder")}" aria-describedby="sl-caps sl-form-message" required<#if failed> aria-invalid="true"</#if>><button id="sl-reveal" class="sl-reveal" type="button" aria-controls="password" aria-pressed="false" aria-label="${msg("sre.showPassword")}" data-text-show="${msg("sre.show")}" data-text-hide="${msg("sre.hide")}" data-label-show="${msg("sre.showPassword")}" data-label-hide="${msg("sre.hidePassword")}" hidden>${msg("sre.show")}</button></div>
<p id="sl-caps" class="sl-caps" hidden>${msg("sre.caps")}</p>
</div>
<#if failed>
<div id="sl-form-message" class="sl-message" role="alert" data-tone="red">${kcSanitize(messagesPerField.getFirstError('username','password'))?no_esc}</div>
<#else>
<div id="sl-form-message" class="sl-message" role="status" aria-live="polite" hidden></div>
</#if>
<input type="hidden" id="id-hidden-input" name="credentialId"<#if auth.selectedCredential?has_content> value="${auth.selectedCredential}"</#if>>
<button id="kc-login" class="sl-submit" name="login" type="submit"><span id="sl-submit-text">${msg("doLogIn")}</span><@layout.icon "arrow"/></button>
</form>
</#if>
</#if>
</@layout.registrationLayout>
