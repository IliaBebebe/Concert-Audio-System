document.addEventListener('DOMContentLoaded', () => {
    const selectFolderBtn = document.getElementById('selectFolderBtn');
    const selectFolderLabel = document.getElementById('selectFolderLabel');
    const closeWelcomeBtn = document.getElementById('closeWelcomeBtn');
    const action = document.getElementById('welcomeAction');
    const status = document.getElementById('welcomeStatus');
    const setBusy = (busy) => {
        selectFolderBtn.disabled = busy;
        action.setAttribute('aria-busy', String(busy));
        selectFolderLabel.textContent = busy ? 'Выбор папки…' : 'Выбрать папку с музыкой';
    };
    closeWelcomeBtn.addEventListener('click', () => window.close());
    selectFolderBtn.addEventListener('click', async () => {
        if (selectFolderBtn.disabled) return;
        setBusy(true);
        status.classList.remove('is-error');
        status.textContent = 'Выберите папку в открывшемся системном окне.';
        try {
            const result = await window.electronAPI.selectMusicFolderAndOpenMain();
            if (result?.success) {
                selectFolderLabel.textContent = 'Открываем CAS…';
                status.textContent = 'Подготавливаем рабочее пространство.';
                return;
            }
            status.textContent = result?.canceled
                ? 'Выбор отменён. Выберите папку, когда будете готовы.'
                : result?.error || 'Не удалось открыть папку. Попробуйте ещё раз.';
            status.classList.toggle('is-error', !result?.canceled);
        } catch {
            status.textContent = 'Не удалось открыть папку. Попробуйте ещё раз.';
            status.classList.add('is-error');
        }
        setBusy(false);
        selectFolderBtn.focus();
    });
});
