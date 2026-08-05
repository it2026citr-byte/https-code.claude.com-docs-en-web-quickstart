@echo off
rem ============================================================================
rem  Выгрузка конфигурации erp_copy2 в XML для анализа структуры и доработок.
rem
rem  Перед запуском:
rem    1) подставьте путь к своей версии платформы (V8_BIN);
rem    2) подставьте учётные данные (лучше через переменные окружения,
rem       не хардкодить пароль в файле, который лежит в git);
rem    3) убедитесь, что на диске есть 5-15 ГБ — выгрузка ERP объёмная.
rem
rem  Время выполнения: 20-60 минут.
rem ============================================================================

setlocal

set "V8_BIN=C:\Program Files\1cv8\8.3.24.1548\bin\1cv8.exe"
set "IB=/S erpdevs\erp_copy2"
set "USR=%ERP_TEST_USER%"
set "PWD=%ERP_TEST_PWD%"
set "OUT=D:\dump\erp_copy2"

if "%USR%"=="" (
  echo [!] Не заданы переменные окружения ERP_TEST_USER / ERP_TEST_PWD
  exit /b 1
)

if not exist "%OUT%" mkdir "%OUT%"

echo [1/3] Выгрузка конфигурации в XML...
"%V8_BIN%" DESIGNER %IB% /N "%USR%" /P "%PWD%" ^
  /DumpConfigToFiles "%OUT%\xml" -Format Hierarchical ^
  /Out "%OUT%\dump-config.log" /DisableStartupMessages
if errorlevel 1 goto :error

echo [2/3] Выгрузка списка расширений...
"%V8_BIN%" DESIGNER %IB% /N "%USR%" /P "%PWD%" ^
  /DumpCfg "%OUT%\extensions" -AllExtensions ^
  /Out "%OUT%\dump-ext.log" /DisableStartupMessages
if errorlevel 1 echo [!] Расширения выгрузить не удалось - возможно, их нет

echo [3/3] Готово. Результат: %OUT%
echo.
echo Что прислать для доработки чек-листа:
echo   - %OUT%\xml\Configuration.xml  (перечень объектов)
echo   - список каталогов %OUT%\xml\Documents и %OUT%\xml\Catalogs
echo   - содержимое %OUT%\extensions
echo   - файлы db_statistics.csv, object_links.csv, func_options.csv
goto :eof

:error
echo [X] Ошибка выгрузки. Смотрите %OUT%\dump-config.log
exit /b 1
