(function expose(root) {
  function createSettings({ state, config, actions, env }) {
    function renderNoteEditingSettings() {
      const enabled = state.persistence.data.settings.selectionCardPopupEnabled !== false;
      config.$('#selectionCardPopupEnabled').checked = enabled;
      config.$('#selectionCardPopupEnabled').disabled = state.shell.selectionCardPreferencePending;
      config.$('#selectionCardPopupState').textContent = state.shell.selectionCardPreferencePending ? '保存中…' : enabled ? '已开启' : '已关闭';
    }

    async function setNoteSelectionCardPopupEnabled(enabled) {
      if (state.shell.selectionCardPreferencePending) return false;
      const sync = () => {
        actions.renderNoteEditingSettings();
        env.window.dispatchEvent(new env.Event('memokeep-selection-card-preference-changed'));
      };
      return env.application.operations.settings.setSelectionCardPopupEnabled(enabled, {
        onStart: () => { state.shell.selectionCardPreferencePending = true; sync(); },
        onFinish: () => { state.shell.selectionCardPreferencePending = false; sync(); }
      });
    }

    async function openNoteEditingSettings() {
      if (!await env.application.editor.session.leaveActiveNoteEditor()) return false;
      actions.showView('settings');
      config.$('[data-settings-panel="editor"]').click();
      config.$('#selectionCardPopupEnabled').focus({ preventScroll: true });
      return true;
    }

    function renderSettings() {
      actions.renderFreeReviewSettings?.();
      actions.renderNoteEditingSettings();
      renderReviewSchedule();
      const fast=config.$('#fastReviewEnabled');if(fast)fast.checked=Boolean(state.persistence.data.settings.fastReview);
      const answerFirst=config.$('#answerFirstEnabled');if(answerFirst)answerFirst.checked=state.persistence.data.settings.answerFirst!==false;
      const autoGists=config.$('#autoAddGists');if(autoGists)autoGists.checked=Boolean(state.persistence.data.settings.autoAddGists);
      const undo=config.$('#undoBackupRestoreBtn');if(undo){undo.disabled=!state.shell.backupUndoAvailable;if(config.desktop?.backupPreviewSupported)void config.desktop.importBackup({status:true}).then(value=>{state.shell.backupUndoAvailable=value.canUndo;undo.disabled=!value.canUndo}).catch(()=>{});}
      env.window.dispatchEvent(new env.Event('memokeep-selection-card-preference-changed'));
      config.$('#petEnabled').checked = env.application.state.settings.current.petEnabled;
      config.$('#notificationsEnabled').checked = env.application.state.settings.current.notificationsEnabled;
      const reminderValue = String(env.application.state.settings.current.reminderMinutes);
      config.$('#reminderMinutes').value = reminderValue;
      state.shell.reminderIntervalChoices?.setChoiceByValue(reminderValue);
      config.$('#activeHoursStart').value = env.application.state.settings.current.activeHoursStart;
      config.$('#activeHoursEnd').value = env.application.state.settings.current.activeHoursEnd;
      const storagePath = config.$('#knowledgeStoragePath');
      if (config.desktop?.markdownPublishing) {
        storagePath.closest('section').querySelector('h2').textContent = 'Markdown 持续发布';
        storagePath.previousElementSibling.textContent = '当前发布目录';
        config.$('#chooseKnowledgeStorageBtn').textContent = '选择发布目录';
      }
      storagePath.textContent = env.application.state.settings.current.knowledgeStoragePath
        || (config.desktop?.markdownPublishing ? '未选择发布目录' : state.shell.localDataPath);
      config.$('#knowledgeSyncHint').textContent = ''; config.$('#knowledgeSyncHint').hidden = true;
      config.$('#dataSummary').textContent = `${env.application.state.knowledge.libraries.length} 个知识库 · ${env.application.state.knowledge.documents.length} 个文档 · ${env.application.state.knowledge.items.length} 条知识 · ${env.application.state.cards.all.length} 张卡片 · ${env.application.state.memos.all.length} 条备忘录 · ${env.application.state.review.records.length} 次复习`;
    }

    async function exportBackup() {
      if(!await env.application.editor.session.flushNoteTabsForWindowClose())return;
      try {
        if (config.desktop) { const path = await config.desktop.exportBackup(state.persistence.data); if (!path) return; actions.showToast('完整备份已导出'); }
        else actions.downloadBlob(JSON.stringify(state.persistence.data, null, 2), `MemoKeep-backup-${actions.todayKey()}.json`, 'application/json');
        try { env.localStorage.setItem('memokeep-last-backup-at', String(Date.now())); } catch { /* 只影响侧栏的备份提示 */ }
        actions.renderSidebarFooterStatus?.();
      } catch(error) { actions.showToast(`导出失败：${error.message}`,true); }
    }

    function downloadBlob(content, name, type) { const link = env.document.createElement('a'); link.href = env.URL.createObjectURL(new env.Blob([content], { type })); link.download = name; link.click(); env.setTimeout(() => env.URL.revokeObjectURL(link.href), 1000); }

    function backupCounts(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.cards) || !Array.isArray(input.documents) || ['__proto__','prototype','constructor'].some(key => Object.hasOwn(input,key))) throw new Error('不是有效的MemoKeep备份');
      if(input.version != null && ![1,2].includes(input.version))throw new Error('备份版本暂不支持');
      for(const key of ['documents','cardDocuments','cards','items','knowledgeBases','cardFolders','cardNotebooks','memos','plans','focusSessions','noteTags','cardCandidates','sourceChanges','reviewRecords','trash']){
        if(input[key]!=null&&!Array.isArray(input[key]))throw new Error(`备份字段${key}应为列表`);
        const ids=new Set();for(const row of input[key]||[]){if(!row||typeof row.id!=='string'||!row.id||ids.has(row.id))throw new Error(`备份字段${key}含无效或重复ID`);ids.add(row.id);}
      }
      for(const doc of [...input.documents,...(input.cardDocuments||[])])if(doc.metadata?.versions!=null&&!Array.isArray(doc.metadata.versions))throw new Error('备份笔记历史应为列表');
      if(input.settings!=null&&(typeof input.settings!=='object'||Array.isArray(input.settings)))throw new Error('备份设置无效');
      return {libraries:(input.knowledgeBases||[]).length,notes:input.documents.length+(input.cardDocuments||[]).length,cards:input.cards.length,reviews:(input.reviewRecords||[]).length,memos:(input.memos||[]).length,candidates:(input.cardCandidates||[]).length,media:Array.isArray(input.backup?.media)?input.backup.media.length:new Set(env.MemoKeepDomain?.dataImageIds?.(input)||[]).size,versions:[...input.documents,...(input.cardDocuments||[])].reduce((sum,doc)=>sum+(doc.metadata?.versions||[]).length,0)};
    }
    function adoptRestoredBackup(restored) {
      state.persistence.persistedData=env.structuredClone(restored);state.persistence.data=actions.normalize(restored);
      state.persistence.sharedDataToken=null;
      state.knowledge.selectedLibraryId=state.persistence.data.knowledgeBases[0]?.id||null;
      actions.renderAll();actions.showToast('备份恢复成功，可在数据设置中撤销本次恢复');
    }
    function showBackupPreview(preview, apply) {
      const current=actions.backupCounts(state.persistence.data),labels={libraries:'知识库',notes:'笔记',cards:'卡片',reviews:'复习记录',memos:'备忘录',candidates:'候选',versions:'历史版本',media:'内含图片'};
      const counts = Object.entries(labels).map(([key, label]) => {
        const change = preview.changes?.[key];
        const detail = change ? `<small>新增 ${Number(change.added)} · 更新 ${Number(change.updated)} · 移除 ${Number(change.removed)}</small>` : '';
        return `<div><span>${label}</span><strong>${current[key] || 0} → ${preview.summary[key] || 0}</strong>${detail}</div>`;
      }).join('');
      const attachmentCounts = Object.values(preview.extensions || {}).map(summary =>
        `<div data-backup-extension><span>${actions.escapeHtml(summary.label || '扩展附件')}</span><strong>可恢复 ${Number(summary.attachments) || 0} · 缺少 ${Number(summary.missing) || 0}</strong></div>`).join('');
      const warnings = (Array.isArray(preview.warnings) ? preview.warnings : []).filter(message => typeof message === 'string').map(message =>
        `<p class="hint" data-backup-warning>${actions.escapeHtml(message)}</p>`).join('');
      const dialog=env.document.createElement('dialog');dialog.className='backup-preview-dialog';dialog.id='backupRestorePreview';dialog.setAttribute('aria-labelledby','backupPreviewTitle');
      dialog.innerHTML=`<header><h2 id="backupPreviewTitle">恢复前检查</h2><button type="button" aria-label="关闭" data-backup-cancel>×</button></header><p>${actions.escapeHtml(preview.name||'JSON备份')}</p><div class="backup-preview-counts">${counts}${attachmentCounts}</div><p class="hint">将替换本机内容，可撤销；存储目录不变。</p>${preview.legacy?'<p class="hint">此备份没有完整的本地图片清单。</p>':''}${warnings}<p data-backup-error role="alert"></p><footer><button type="button" data-backup-cancel>取消</button><button type="button" data-backup-apply class="primary">确认恢复</button></footer>`;
      env.document.body.append(dialog);let applying=false,applied=false;
      const close=()=>{if(!applying)dialog.close()};dialog.querySelectorAll('[data-backup-cancel]').forEach(button=>button.onclick=close);
      dialog.addEventListener('cancel',event=>{if(applying)event.preventDefault()});
      dialog.addEventListener('close',()=>{if(!applied&&preview.token)void config.desktop.importBackup({cancel:preview.token}).catch(()=>{});dialog.remove()},{once:true});
      dialog.querySelector('[data-backup-apply]').onclick=async()=>{
        if(applying)return;applying=true;dialog.querySelectorAll('button').forEach(button=>button.disabled=true);dialog.querySelector('[data-backup-error]').textContent='';
        try{const restored=await apply();applied=true;state.shell.backupUndoAvailable=true;dialog.close();actions.adoptRestoredBackup(restored)}
        catch(error){dialog.querySelector('[data-backup-error]').textContent=`恢复失败：${error.message}`}
        finally{applying=false;if(dialog.isConnected)dialog.querySelectorAll('button').forEach(button=>button.disabled=false)}
      };dialog.showModal();dialog.querySelector('[data-backup-apply]').focus();
    }
    async function importBackup() {
      if(!await env.application.editor.session.flushNoteTabsForWindowClose())return;
      try{
        if(!config.desktop){config.$('#webBackupInput').click();return}
        if(config.desktop.backupPreviewSupported){const preview=await config.desktop.importBackup({preview:true});if(preview)actions.showBackupPreview(preview,()=>config.desktop.importBackup({apply:preview.token}));return}
        const confirmed=await actions.showConfirmDialog({title:'确认恢复备份？',message:'将替换当前内容。',confirmLabel:'继续恢复',tone:'warning'});
        if(confirmed){const restored=await config.desktop.importBackup();if(restored)actions.adoptRestoredBackup(restored)}
      }catch(error){actions.showToast(`恢复失败：${error.message}`,true)}
    }
    async function undoBackupRestore() {
      if(!await env.application.editor.session.flushNoteTabsForWindowClose())return;
      if(!await actions.showConfirmDialog({title:'撤销上次恢复？',message:'将恢复到导入前；有新修改时无法撤销。',confirmLabel:'撤销恢复',tone:'warning'}))return;
      try{
        if(config.desktop?.backupPreviewSupported){const restored=await config.desktop.importBackup({undo:true});state.shell.backupUndoAvailable=false;actions.adoptRestoredBackup(restored)}
        else if(state.shell.webBackupUndo){
          if(JSON.stringify(state.persistence.data)!==JSON.stringify(state.shell.webBackupApplied))throw new Error('恢复后已有新的修改，请先备份当前内容；不能直接覆盖撤销');
          const previous=state.shell.webBackupUndo;await env.application.persistence.transact(data=>{for(const key of Object.keys(data))delete data[key];Object.assign(data,env.structuredClone(previous))});state.shell.webBackupUndo=null;state.shell.webBackupApplied=null;state.shell.backupUndoAvailable=false;actions.renderAll();
        }
        actions.showToast('已撤销上次恢复');
      }catch(error){actions.showToast(error.message,true)}
    }
    // 复习时先作答（design/prototype/memory-boost-20261112.md），默认打开。
    async function setAnswerFirst(enabled) {
      const previous=state.persistence.data.settings.answerFirst!==false;
      try{await env.application.persistence.transact(data=>{data.settings.answerFirst=Boolean(enabled)});actions.renderSettings()}
      catch{const input=config.$('#answerFirstEnabled');if(input)input.checked=previous}
    }
    // 复习间隔（design/prototype/review-intervals-20261113.html 方案 A）：照着复习时的四个评分按钮，每个下面选一个时间；改完就保存。
    const scheduleUi=()=>({again:config.$('#reviewAgain'),hard:config.$('#reviewHard'),good:config.$('#reviewGood'),easy:config.$('#reviewEasy'),retention:config.$('#reviewRetention'),pace:config.$('#reviewPaceHint'),maximum:config.$('#reviewMaximumInterval'),reset:config.$('#reviewScheduleReset')});
    const paceHints={0.85:'复习少一些，到期时大约还记得 85%。',0.9:'到期时大约还记得 90%。',0.95:'复习多一些，到期时大约还记得 95%。'};
    const stepMinutes=step=>Number.parseInt(step,10)*({m:1,h:60,d:1440})[step.slice(-1)];
    // 已保存的值不在固定选项里时，临时加一项，不悄悄改掉。
    function selectValue(select,value,label){
      select.querySelector('[data-custom]')?.remove();
      if(![...select.options].some(option=>option.value===value)){const option=env.document.createElement('option');option.value=value;option.textContent=label;option.dataset.custom='';select.append(option)}
      select.value=value;
    }
    function renderReviewSchedule(){
      const ui=scheduleUi(),scheduler=env.MemoScheduler;if(!ui.again||!scheduler?.normalizeOptions)return;
      const options=scheduler.normalizeOptions(state.persistence.data.settings.reviewSchedule),sample=scheduler.samplePreview(options);
      const auto=scheduler.samplePreview({...options,hardMinutes:null,easyDays:null});
      selectValue(ui.again,options.learningSteps[0],sample.again);
      // 只有一个学习间隔时，「记住」直接进入长期复习，时间由算法定。
      selectValue(ui.good,options.learningSteps[1]||'',options.learningSteps[1]?sample.good:`自动 · ${sample.good}`);
      ui.hard.options[0].textContent=`自动 · ${auto.hard}`;ui.easy.options[0].textContent=`自动 · ${auto.easy}`;
      selectValue(ui.hard,options.hardMinutes?String(options.hardMinutes):'',sample.hard);
      selectValue(ui.easy,options.easyDays?String(options.easyDays):'',sample.easy);
      selectValue(ui.maximum,String(options.maximumInterval),`${options.maximumInterval} 天`);
      ui.retention.querySelectorAll('[data-value]').forEach(button=>button.setAttribute('aria-checked',String(Number(button.dataset.value)===options.retention)));
      ui.pace.textContent=paceHints[options.retention]||`到期时大约还记得 ${Math.round(options.retention*100)}%。`;
      ui.reset.hidden=JSON.stringify(options)===JSON.stringify(scheduler.normalizeOptions());
    }
    async function saveReviewSchedule(change={}){
      const ui=scheduleUi(),scheduler=env.MemoScheduler,current=scheduler.normalizeOptions(state.persistence.data.settings.reviewSchedule);
      let next;
      try{
        // 「记住」要比「忘记」久：改「忘记」后不够久时，「记住」跟着换成下一个更久的选项。
        const again=ui.again.value;let good=ui.good.value;
        if(good&&stepMinutes(good)<=stepMinutes(again))good=[...ui.good.options].map(option=>option.value).find(value=>value&&stepMinutes(value)>stepMinutes(again))||'';
        next=scheduler.validateOptions({...current,learningSteps:good?[again,good]:[again],hardMinutes:ui.hard.value||null,easyDays:ui.easy.value||null,maximumInterval:Number(ui.maximum.value),...change});
      }catch(error){actions.showToast(error.message,true);renderReviewSchedule();return false}
      if(JSON.stringify(next)===JSON.stringify(current)){renderReviewSchedule();return true}
      try{await env.application.persistence.transact(data=>{data.settings.reviewSchedule=next});scheduler.configure(next);renderReviewSchedule();return true}
      catch{actions.showToast('复习间隔没有保存成功，请再试一次',true);renderReviewSchedule();return false}
    }
    function bindReviewSchedule(){
      const ui=scheduleUi();if(!ui.again)return;
      for(const select of [ui.again,ui.hard,ui.good,ui.easy,ui.maximum])select.onchange=()=>void saveReviewSchedule();
      ui.retention.onclick=event=>{const option=event.target.closest('[data-value]');if(option)void saveReviewSchedule({retention:Number(option.dataset.value)})};
      ui.reset.onclick=()=>void saveReviewSchedule(env.MemoScheduler.normalizeOptions());
    }
    async function setFastReview(enabled) {
      const previous=Boolean(state.persistence.data.settings.fastReview);
      try{await env.application.persistence.transact(data=>{data.settings.fastReview=Boolean(enabled)});actions.renderSettings()}
      catch{const input=config.$('#fastReviewEnabled');if(input)input.checked=previous}
    }

    async function exportCards() { if (config.desktop) { const path = await config.desktop.exportCards(state.persistence.data.cards); if (path) actions.showToast('卡片 CSV 已导出'); } else { const csv = [['问题','答案','标签'], ...state.persistence.data.cards.map(c=>[c.question,c.answer,(c.tags||[]).join('|')])].map(row=>row.map(value=>`"${String(value).replaceAll('"','""')}"`).join(',')).join('\n'); actions.downloadBlob(`\uFEFF${csv}`, `MemoKeep-cards-${actions.todayKey()}.csv`, 'text/csv'); } }

    async function handleChooseKnowledgeStorage() {
      if (!config.desktop?.chooseKnowledgeStorageFolder) {
        actions.showToast('网页端暂不支持选择本地目录', true);
        return;
      }
      const selectedPath = await config.desktop.chooseKnowledgeStorageFolder(state.persistence.data.settings.knowledgeStoragePath);
      if (!selectedPath) return;

      state.persistence.data.settings.knowledgeStoragePath = selectedPath;
      await env.application.persistence.save();
      actions.renderSettings();
      if (config.desktop.markdownPublishing) {
        const { exportError } = await config.desktop.getMarkdownPublishStatus();
        actions.showToast(exportError || 'Markdown 发布目录已更新', Boolean(exportError));
      } else actions.showToast('存储位置已更新，知识库与记忆卡片笔记已同步');
    }

    async function handleWebBackupInput(event) {
      try {
        const file=event.target.files[0];if(!file)return;if(file.size>700*1024*1024)throw new Error('备份文件过大');
        const raw=JSON.parse(await file.text()),summary=actions.backupCounts(raw);
        if(raw.backup?.media?.length)throw new Error('此备份包含本地图片，请在桌面版恢复以保留完整媒体');
        if(raw.backup?.extensions && Object.keys(raw.backup.extensions).length)throw new Error('此备份包含扩展附件，请在支持相应功能的桌面版恢复');
        actions.showBackupPreview({name:file.name,summary,legacy:!raw.backup?.mediaIncluded},async()=>{
          const previous=env.structuredClone(state.persistence.data),normalized=actions.normalize(raw);delete normalized.backup;
          normalized.settings={...normalized.settings,knowledgeStoragePath:previous.settings.knowledgeStoragePath||''};
          await env.application.persistence.transact(data=>{for(const key of Object.keys(data))delete data[key];Object.assign(data,normalized)});
          state.shell.webBackupUndo=previous;state.shell.webBackupApplied=env.structuredClone(state.persistence.data);return env.application.state.read();
        });
      }catch(error){actions.showToast(`备份无效：${error.message}`,true)}finally{event.target.value=''}
    }

    function bindSettingsEvents() {
      config.$('#selectionCardPopupEnabled').onchange = event => actions.setNoteSelectionCardPopupEnabled(event.target.checked);
      config.$('#petEnabled').onchange = async event => {
        state.persistence.data.settings.petEnabled = event.target.checked;
        await env.application.persistence.save();
        if (config.desktop) event.target.checked ? config.desktop.showPet() : config.desktop.hidePet();
      };

      config.$('#notificationsEnabled').onchange = async event => {
        state.persistence.data.settings.notificationsEnabled = event.target.checked;
        if (!config.desktop && event.target.checked && env.Notification.permission === 'default') {
          await env.Notification.requestPermission();
        }
        await env.application.persistence.save();
        if (event.target.checked) actions.checkMemoReminders();
      };

      config.$('#reminderMinutes').onchange = async event => {
        state.persistence.data.settings.reminderMinutes = Number(event.target.value);
        await env.application.persistence.save();
        actions.scheduleReminder();
      };

      const saveActiveHours = async () => {
        state.persistence.data.settings.activeHoursStart = config.$('#activeHoursStart').value;
        state.persistence.data.settings.activeHoursEnd = config.$('#activeHoursEnd').value;
        await env.application.persistence.save();
      };
      config.$('#activeHoursStart').onchange = saveActiveHours;
      config.$('#activeHoursEnd').onchange = saveActiveHours;

      config.$('#chooseKnowledgeStorageBtn').onclick = actions.handleChooseKnowledgeStorage;
      config.$('#undoBackupRestoreBtn') && (config.$('#undoBackupRestoreBtn').onclick=actions.undoBackupRestore);
      bindReviewSchedule();
      config.$('#fastReviewEnabled') && (config.$('#fastReviewEnabled').onchange=event=>actions.setFastReview(event.target.checked));
      config.$('#answerFirstEnabled') && (config.$('#answerFirstEnabled').onchange=event=>setAnswerFirst(event.target.checked));
      config.$('#autoAddGists') && (config.$('#autoAddGists').onchange=event=>actions.setAutoAddGists?.(event.target.checked));
      config.$('#settingsStudyPlanBtn') && (config.$('#settingsStudyPlanBtn').onclick=actions.openStudyPlanSettings);
      config.$('#exportBackupBtn').onclick = actions.exportBackup;
      const moduleExport = config.$('#exportModuleJsonBtn');
      if (moduleExport && config.desktop?.exportModuleJson) {
        moduleExport.hidden = false;
        moduleExport.onclick = async () => {
          if (!await env.application.editor.session.flushNoteTabsForWindowClose()) return;
          try { if (await config.desktop.exportModuleJson()) actions.showToast('模块 JSON 已导出'); }
          catch (error) { actions.showToast(error.message, true); }
        };
      }
      config.$('#importBackupBtn').onclick = actions.importBackup;
      config.$('#exportCardsBtn').onclick = actions.exportCards;
    }
    return { renderNoteEditingSettings, setNoteSelectionCardPopupEnabled, openNoteEditingSettings, renderSettings, exportBackup, downloadBlob, backupCounts, showBackupPreview, adoptRestoredBackup, importBackup, undoBackupRestore, setFastReview, exportCards, handleChooseKnowledgeStorage, handleWebBackupInput, bindSettingsEvents };
  }
  Object.assign(root.MemoKeepShell ||= {}, { createSettings });
})(globalThis);
