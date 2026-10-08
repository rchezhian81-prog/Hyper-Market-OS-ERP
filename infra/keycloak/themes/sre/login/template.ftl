<#--
  The OB-18 frame for every Keycloak sign-in page (owner's approved design, 5 Oct 2026 · ADR-0019).

  The same markup as the pilot sign-in page (infra/pilot/demo-login/ui.ts: shell, topbar, intro, footer, renderSignIn):
  the practice strip (pilot only), the top bar with the S+ mark, English / தமிழ் and Help, the intro column, the white
  card, the connection line, the footer and the help/connection dialog. Each page's own content goes inside the card:
  its "header" section is the card's heading, its "form" section sits under it.

  Honest signals only: no remember-me, no role selector, no simulated state, no forgot-password link. The language
  switch is Keycloak's own (locale.supported / l.url), so the server renders every word in the chosen language.
  No inline script, no inline style, nothing fetched from another host: the stylesheet and the script are this theme's
  own resources, the icons are inline SVG (Lucide shapes, ISC licence), the fonts are the system's.
-->
<#macro icon name><svg class="sl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><#switch name><#case "store"><path d="M2 7l1.5-4h17L22 7"/><path d="M2 7a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M4 10v11h16V10"/><path d="M9 21v-6h6v6"/><#break><#case "cart"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/><#break><#case "boxes"><path d="M3 21V8l9-4 9 4v13"/><path d="M3 21h18"/><rect x="7" y="13" width="4" height="4"/><rect x="13" y="13" width="4" height="4"/><path d="M10 9h4"/><#break><#case "receipt"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><path d="M14 8H8"/><path d="M16 12H8"/><path d="M13 16H8"/><#break><#case "monitor"><rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/><#break><#case "cloud"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z"/><#break><#case "login"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><#break><#case "user"><circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/><#break><#case "lock"><circle cx="12" cy="16" r="1"/><rect x="3" y="10" width="18" height="12" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/><#break><#case "arrow"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/><#break><#case "help"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/><#break><#case "usercheck"><path d="M2 21a8 8 0 0 1 13.29-6"/><circle cx="10" cy="8" r="5"/><path d="M16 19l2 2 4-4"/><#break><#case "leaf"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/><#break><#case "info"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/><#break><#case "x"><path d="M18 6L6 18"/><path d="M6 6l12 12"/><#break></#switch></svg></#macro>
<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<#assign sreLang = (locale.currentLanguageTag)!"en">
<#assign sreStrip = (properties.sreTrialStrip!"0")>
<!DOCTYPE html>
<html lang="${sreLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${msg("sre.signIn")} — SRE Hyper Market</title>
<#if properties.styles?has_content><#list properties.styles?split(' ') as style>
<link href="${url.resourcesPath}/${style}" rel="stylesheet">
</#list></#if>
<script type="module" src="${url.resourcesPath}/js/sre-login.js"></script>
<#if scripts??><#list scripts as script>
<script src="${script}"></script>
</#list></#if>
</head>
<body<#if bodyClass?has_content> class="${bodyClass}"</#if> data-sre-sso-url="${url.ssoLoginInOtherTabsUrl}">
<div id="sre-login" lang="${sreLang}">
<#if sreStrip == "1" || sreStrip == "true">
<div class="sl-strip" role="status">${msg("sre.strip")}</div>
</#if>
<div class="sl-product">
<header class="sl-topbar">
<div class="sl-brand" aria-label="SRE Hyper Market">
<div class="sl-mark" aria-hidden="true">S<span>+</span></div>
<div class="sl-brand-name">SRE<small>HYPER MARKET</small></div>
</div>
<div class="sl-top-actions">
<#if realm.internationalizationEnabled && locale.supported?size gt 1>
<nav class="sl-language" id="kc-locale" aria-label="${msg("sre.languageLabel")}">
<#list locale.supported as l>
<a href="${l.url}" lang="${l.languageTag}" hreflang="${l.languageTag}" data-language="${l.languageTag}"<#if l.languageTag == sreLang> aria-current="true"</#if>>${l.label}</a>
</#list>
</nav>
</#if>
<button class="sl-text-button sl-top-help" data-open="help" type="button"><@icon "help"/><span>${msg("sre.help")}</span></button>
</div>
</header>
<main class="sl-main">
<section class="sl-intro" aria-label="${msg("sre.workspaceLabel")}">
<div class="sl-eyebrow">${msg("sre.eyebrow")}</div>
<p class="sl-hero"><span class="sl-hero-ink">${msg("sre.hero1")}</span><span>${msg("sre.hero2")}</span></p>
<p class="sl-intro-copy">${msg("sre.heroCopy")}</p>
<div class="sl-illustration" aria-hidden="true">
<div class="sl-workspace">
<div class="sl-workspace-head"><div class="sl-workspace-icon"><@icon "store"/></div><div><strong>SRE Hyper Market</strong><small>${msg("sre.workspace")}</small></div></div>
<div class="sl-three">
<div><@icon "cart"/><span>${msg("sre.purchase")}</span></div>
<div><@icon "boxes"/><span>${msg("sre.inventory")}</span></div>
<div><@icon "receipt"/><span>${msg("sre.sales")}</span></div>
</div>
</div>
<div class="sl-illustration-label"><@icon "monitor"/><span>${msg("sre.storeDesktop")}</span><span>·</span><@icon "cloud"/><span>${msg("sre.onlineWorkspace")}</span></div>
</div>
</section>
<section class="sl-login-area" aria-labelledby="kc-page-title">
<div class="sl-login-card">
<div class="sl-login-kicker"><@icon "login"/><span>${msg("sre.staffAccess")}</span></div>
<h1 id="kc-page-title"><#nested "header"></h1>
<#if auth?has_content && auth.showUsername() && !auth.showResetCredentials()>
<#nested "show-username">
<div id="kc-username" class="sl-store sre-attempted">
<@icon "user"/>
<div><strong id="kc-attempted-username">${auth.attemptedUsername}</strong></div>
<a id="reset-login" class="sl-text-button sre-restart" href="${url.loginRestartFlowUrl}">${msg("restartLoginTooltip")}</a>
</div>
</#if>
<#nested "sre-lead">
<#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
<#if message.type = 'error'>
<div id="sre-page-message" class="sl-message" role="alert" data-tone="red">${kcSanitize(message.summary)?no_esc}</div>
<#else>
<div id="sre-page-message" class="sl-notice" role="status"<#if message.type = 'warning'> data-tone="amber"</#if>><@icon "info"/><span>${kcSanitize(message.summary)?no_esc}</span></div>
</#if>
</#if>
<#nested "form">
<#if auth?has_content && auth.showTryAnotherWayLink()>
<form id="kc-select-try-another-way-form" action="${url.loginAction}" method="post">
<input type="hidden" name="tryAnotherWay" value="on">
<button id="try-another-way" class="sl-secondary" type="submit">${msg("doTryAnotherWay")}</button>
</form>
</#if>
<#nested "socialProviders">
<#if displayInfo>
<div id="kc-info" class="${properties.kcSignUpClass!}"><div id="kc-info-wrapper" class="${properties.kcInfoAreaWrapperClass!}"><#nested "info"></div></div>
</#if>
<div class="sl-help-row"><button type="button" data-open="help" class="sl-text-button">${msg("sre.needHelp")}</button></div>
<div class="sl-personal"><@icon "usercheck"/><span>${msg("sre.personal")}</span></div>
</div>
<div class="sl-status" id="sl-connection-status" data-tone="green"><span class="sl-dot" aria-hidden="true"></span><span id="sl-connection-text">${msg("sre.connectionOnline")}</span><button type="button" data-open="connection">${msg("sre.details")}</button></div>
</section>
</main>
<footer class="sl-footer"><span><@icon "leaf"/><span>${msg("sre.footer")}</span></span><span>SRE Hyper Market<span aria-hidden="true">·</span><span>${msg("sre.retailWorkspace")}</span></span></footer>
<div id="sl-dialog-host" class="sl-dialog-host" hidden
 data-help-title="${msg("sre.helpTitle")}" data-help-copy="${msg("sre.helpCopy")}"
 data-connection-title="${msg("sre.connectionTitle")}" data-connection-copy="${msg("sre.onlineCopy")}">
<section class="sl-dialog" role="dialog" aria-modal="true" aria-labelledby="sl-dialog-title" aria-describedby="sl-dialog-copy">
<div class="sl-dialog-head"><h3 id="sl-dialog-title"></h3><button id="sl-dialog-close" type="button" class="sl-close" aria-label="${msg("sre.close")}"><@icon "x"/></button></div>
<p id="sl-dialog-copy"></p><button id="sl-dialog-done" class="sl-submit" type="button">${msg("sre.gotIt")}</button>
</section>
</div>
</div>
</div>
</body>
</html>
</#macro>
