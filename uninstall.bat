@echo off
chcp 65001 > nul
title ScoreExt - アンインストール

echo ======================================================
echo  ScoreExt アンインストーラー (削除ツール)
echo ======================================================
echo.
echo このバッチファイルは、ScoreExt フォルダ内のすべてのプログラム、
echo 自動ダウンロードされたポータブル環境 (Node.js)、一時ファイル、
echo およびこのフォルダ自体を完全に削除します。
echo.
echo ※ユーザーが他のフォルダへ保存したPDFファイルは削除されません。
echo.

set /p CONFIRM="本当にすべてのデータを削除してアンインストールしますか？ (y/n): "
if /i "%CONFIRM%" neq "y" (
    echo.
    echo 削除をキャンセルしました。
    timeout /t 3 > nul
    exit /b
)

echo.
echo [1/2] 実行中のプログラム(Node.js)を安全に停止しています...
taskkill /f /im node.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [2/2] フォルダとファイルを完全に消去しています...
echo.
echo 削除処理が完了すると、このウィンドウは自動的に閉じます。

:: 自フォルダを安全に丸ごと消去するコマンド (作業ディレクトリを%temp%に移動してから実行)
start "" cmd /c "cd /d %temp% && timeout /t 1 /nobreak >nul && rd /s /q \"%~dp0\""

exit
