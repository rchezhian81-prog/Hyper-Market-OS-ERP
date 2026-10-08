<#--
  "Do you want to sign out?" inside the OB-18 frame — Keycloak's own page with its inline onsubmit handler removed
  (the theme's script guards against a double submit for every form).
-->
<#import "template.ftl" as layout>
<@layout.registrationLayout; section>
<#if section = "header">
${msg("logoutConfirmTitle")}
<#elseif section = "form">
<div id="kc-logout-confirm">
<p class="sl-subtitle">${msg("logoutConfirmHeader")}</p>
<form class="sre-form" action="${url.logoutConfirmAction}" method="post">
<input type="hidden" name="session_code" value="${logoutConfirm.code}">
<button id="kc-logout" class="sl-submit" name="confirmLogout" type="submit"><span>${msg("doLogout")}</span><@layout.icon "arrow"/></button>
</form>
<#if !logoutConfirm.skipLink && (client.baseUrl)?has_content>
<p class="sre-back"><a href="${client.baseUrl}">${kcSanitize(msg("backToApplication"))?no_esc}</a></p>
</#if>
</div>
</#if>
</@layout.registrationLayout>
