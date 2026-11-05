'use strict';

const uiLanguage = document.documentElement.lang === 'ar' ? 'ar' : 'en';
const uiText = {
  ar: {
    Copied: 'تم النسخ', 'Copy unavailable': 'تعذر النسخ', 'Not entered': 'لم يتم الإدخال',
    'All runtime modules currently supported by this release.': 'جميع وحدات التشغيل المدعومة في هذا الإصدار.',
    'No additional permissions declared.': 'لا توجد صلاحيات إضافية محددة.',
    'None': 'لا يوجد', 'Step': 'الخطوة', 'of': 'من'
  }
};
function uiTranslate(value) {
  return uiLanguage === 'ar' ? (uiText.ar[value] || value) : value;
}

document.addEventListener('click', async (event) => {
  const dismiss = event.target.closest('[data-dismiss]');
  if (dismiss) dismiss.closest('.notice')?.remove();

  const copyButton = event.target.closest('[data-copy-target]');
  if (copyButton) {
    const target = document.getElementById(copyButton.dataset.copyTarget);
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.textContent.trim());
      const original = copyButton.textContent;
      copyButton.textContent = uiTranslate('Copied');
      setTimeout(() => { copyButton.textContent = original; }, 1300);
    } catch {
      copyButton.textContent = uiTranslate('Copy unavailable');
    }
  }

  const menuButton = event.target.closest('[data-menu-toggle]');
  if (menuButton) document.querySelector('.sidebar')?.classList.toggle('sidebar-open');
});

document.addEventListener('submit', (event) => {
  const form = event.target.closest('form[data-confirm]');
  if (form && !window.confirm(form.dataset.confirm)) event.preventDefault();
});


const commandDialog = document.querySelector('[data-command-dialog]');
document.addEventListener('click', (event) => {
  if (event.target.closest('[data-command-open]') && commandDialog?.showModal) commandDialog.showModal();
  if (event.target.closest('[data-command-close]')) commandDialog?.close();
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    commandDialog?.showModal?.();
  }
  if (event.key === 'Escape' && commandDialog?.open) commandDialog.close();
});


(() => {
  const form = document.querySelector('[data-builder-form]');
  if (!form) return;
  const steps = [...form.querySelectorAll('[data-builder-step]')];
  const progress = [...document.querySelectorAll('[data-builder-progress] span')];
  const back = form.querySelector('[data-builder-back]');
  const next = form.querySelector('[data-builder-next]');
  const label = form.querySelector('[data-builder-step-label]');
  const templateSelect = form.querySelector('#template-select');
  const commandFeature = {
    ban:'moderation',kick:'moderation',timeout:'moderation',untimeout:'moderation',unban:'moderation',warn:'moderation',warnings:'moderation',modlogs:'moderation',clear:'moderation',lock:'moderation',unlock:'moderation',slowmode:'moderation',
    'set-welcome':'welcome','set-logs':'logging','ticket':'tickets','ticket-config':'tickets',giveaway:'giveaways','giveaway-reroll':'giveaways','automod-config':'automod','set-level-reward':'leveling',rank:'leveling',leaderboard:'leveling',
    daily:'economy',balance:'economy',quiz:'economy',shop:'economy',buy:'economy',inventory:'economy',richest:'economy',
    avatar:'utility',userinfo:'utility',serverinfo:'utility',botinfo:'utility',invite:'utility',poll:'utility',embed:'utility',play:'music',skip:'music',stop:'music',nowplaying:'music','tempvoice-config':'temp_voice','role-button':'reaction_roles',
    'suggestion-config':'suggestions',suggest:'suggestions','birthday-config':'birthday','birthday-set':'birthday','birthday-remove':'birthday','birthday-list':'birthday',
    'counting-config':'counting','starboard-config':'starboard','verify-config':'verification','verification-panel':'verification',
    invites:'invite_tracker','stats-config':'server_statistics',ask:'ai_assistant',translate:'translator'
  };
  const updateRuntimeRequirements = () => {
    const enabled = new Set([...form.querySelectorAll('[name="feature_keys"]:checked')].map(box=>box.value));
    const intents = ['Guilds'];
    if(['welcome','logging','birthday','invite_tracker','verification','server_statistics'].some(key=>enabled.has(key)))intents.push('GuildMembers');
    if(['leveling','automod','counting','starboard'].some(key=>enabled.has(key)))intents.push('GuildMessages','MessageContent');
    if(enabled.has('music')||enabled.has('temp_voice'))intents.push('GuildVoiceStates');
    if(enabled.has('starboard'))intents.push('GuildMessageReactions');
    if(enabled.has('invite_tracker'))intents.push('GuildInvites');
    const target=form.querySelector('[data-builder-intents]');
    if(target)target.textContent=intents.join(' · ');
  };
  const applyTemplateSelection = () => {
    const option = templateSelect?.options[templateSelect.selectedIndex];
    if (!option) return;
    let features = [];
    let commands = [];
    try { features = JSON.parse(option.dataset.features || '[]'); } catch { features = []; }
    try { commands = JSON.parse(option.dataset.commands || '[]'); } catch { commands = []; }
    const enabledFeatures = new Set(features);
    const enabledCommands = new Set(commands);
    form.querySelectorAll('[name="feature_keys"]').forEach(box => { box.checked = enabledFeatures.has(box.value); });
    form.querySelectorAll('[name="command_names"]').forEach(box => {
      const needed = commandFeature[box.value];
      box.checked = enabledCommands.has(box.value) && (!needed || enabledFeatures.has(needed));
    });
    let permissions=[];try{permissions=JSON.parse(option.dataset.permissions||'[]');}catch{}
    const permissionTarget=form.querySelector('[data-builder-permissions]');
    if(permissionTarget)permissionTarget.textContent=permissions.join(' · ')||uiTranslate('No additional permissions declared.');
    updateRuntimeRequirements();
    const selectedName = option.dataset.name || option.textContent.split(' — ')[0];
    const summary = form.querySelector('.template-option');
    if (summary) {
      summary.querySelector('b').textContent = selectedName;
      summary.querySelector('small').textContent = option.value ? option.textContent : uiTranslate('All runtime modules currently supported by this release.');
    }
    form.querySelector('[data-review-template]').textContent = selectedName;
  };
  templateSelect?.addEventListener('change', applyTemplateSelection);
  let current = 1;
  const show = (number) => {
    current = Math.min(8, Math.max(1, number));
    steps.forEach(step => { step.hidden = Number(step.dataset.builderStep) !== current; });
    progress.forEach((item, index) => item.classList.toggle('active', index + 1 <= current));
    back.disabled = current === 1;
    next.hidden = current === 8;
    label.textContent = uiLanguage === 'ar' ? `الخطوة ${current} من 8` : `Step ${current} of 8`;
    if (current === 7) {
      form.querySelector('[data-review-name]').textContent = form.elements.name.value || uiTranslate('Not entered');
      const selected = form.querySelector('#template-select');
      form.querySelector('[data-review-template]').textContent = selected.options[selected.selectedIndex].text.split(' — ')[0];
      form.querySelector('[data-review-features]').textContent = [...form.querySelectorAll('[name="feature_keys"]:checked')].map(x => x.value).join(', ') || uiTranslate('None');
      form.querySelector('[data-review-commands]').textContent = [...form.querySelectorAll('[name="command_names"]:checked')].length;
    }
  };
  next.addEventListener('click', () => {
    if (current === 2 && !form.elements.name.checkValidity()) { form.elements.name.reportValidity(); return; }
    if (current === 3 && !form.elements.token.checkValidity()) { form.elements.token.reportValidity(); return; }
    if (current === 1) {
      const templateId = form.elements.template_id.value;
      const option = form.elements.template_id.options[form.elements.template_id.selectedIndex];
      if (option?.dataset?.locked === 'true') return;
    }
    show(current + 1);
  });
  back.addEventListener('click', () => show(current - 1));
  form.querySelectorAll('[name="feature_keys"]').forEach(box => box.addEventListener('change', () => {
    const enabled = new Set([...form.querySelectorAll('[name="feature_keys"]:checked')].map(x => x.value));
    form.querySelectorAll('[name="command_names"]').forEach(command => {
      if (commandFeature[command.value] && !enabled.has(commandFeature[command.value])) command.checked = false;
    });
    updateRuntimeRequirements();
  }));
  applyTemplateSelection();
  show(1);
})();
