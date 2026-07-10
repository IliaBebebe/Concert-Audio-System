document.addEventListener('DOMContentLoaded', () => {
    const selectFolderBtn = document.getElementById('selectFolderBtn');
    const closeWelcomeBtn = document.getElementById('closeWelcomeBtn');
    const status = document.getElementById('welcomeStatus');

    closeWelcomeBtn?.addEventListener('click', () => window.close());

    selectFolderBtn?.addEventListener('click', async () => {
        if (selectFolderBtn.disabled) return;

        selectFolderBtn.disabled = true;
        if (status) status.textContent = 'Открываем выбор папки…';

        try {
            const result = await window.electronAPI.selectMusicFolderAndOpenMain();
            if (!result?.success) {
                if (status) status.textContent = result?.error || 'Папка не выбрана';
                selectFolderBtn.disabled = false;
            }
        } catch {
            if (status) status.textContent = 'Не удалось открыть выбор папки';
            selectFolderBtn.disabled = false;
        }
    });
});
