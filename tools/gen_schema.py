#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Собирает Template.xml (схема компоновки данных) из текста запроса.

Запрос — единственный источник правды: src/Запросы/ЗапросОтчета.txt.
После правки запроса перезапустить:  python3 tools/gen_schema.py
"""
import html
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
QUERY = ROOT / "src" / "Запросы" / "ЗапросОтчета.txt"
OUT = (ROOT / "src" / "ГантПоЗаказамНаПроизводство" / "Templates"
       / "ОсновнаяСхемаКомпоновкиДанных" / "Ext" / "Template.xml")

# поле набора данных -> заголовок
FIELDS = [
    ("Заказ", "Заказ на производство"),
    ("Номер", "Номер"),
    ("ДатаДокумента", "Дата документа"),
    ("Статус", "Статус"),
    ("Подразделение", "Подразделение"),
    ("ДокументОснование", "Документ-основание"),
    ("ВидИнтервала", "Вид интервала"),
    ("ПорядокВида", "Порядок вида"),
    ("ДатаНачала", "Дата начала"),
    ("ДатаОкончания", "Дата окончания"),
    ("КоличествоДнейПлан", "Количество дней (план)"),
    ("КоличествоЭтапов", "Этапов всего"),
    ("ЗавершеноЭтапов", "Этапов завершено"),
    ("ДатаЗавершенияЗаказа", "Дата завершения по заказу"),
    ("ЭтоФакт", "Это факт"),
]

# ресурсы: путь -> выражение агрегации
RESOURCES = [
    ("ДатаНачала", "Минимум(ДатаНачала)"),
    ("ДатаОкончания", "Максимум(ДатаОкончания)"),
    ("ДлительностьДней", "Максимум(ДлительностьДней)"),
    ("КоличествоДнейПлан", "Максимум(КоличествоДнейПлан)"),
    ("КоличествоЭтапов", "Максимум(КоличествоЭтапов)"),
    ("ЗавершеноЭтапов", "Максимум(ЗавершеноЭтапов)"),
]

CALCULATED = [
    ("ДлительностьДней", 'РазностьДат(ДатаНачала, ДатаОкончания, "ДЕНЬ")',
     "Длительность, дней"),
]

STATUS_TYPE = "ПеречислениеСсылка.СтатусыЗаказовНаПроизводство2_5"


def loc(text, ns="v8"):
    return (f'<{ns}:item><{ns}:lang>ru</{ns}:lang>'
            f'<{ns}:content>{html.escape(text)}</{ns}:content></{ns}:item>')


def dataset_fields():
    out = []
    for name, title in FIELDS:
        out.append(
            '\t\t<field xsi:type="DataSetFieldField">\n'
            f'\t\t\t<dataPath>{name}</dataPath>\n'
            f'\t\t\t<field>{name}</field>\n'
            f'\t\t\t<title xsi:type="v8:LocalStringType">{loc(title)}</title>\n'
            '\t\t</field>')
    return "\n".join(out)


def calculated_fields():
    out = []
    for path, expr, title in CALCULATED:
        out.append(
            '\t<calculatedField>\n'
            f'\t\t<dataPath>{path}</dataPath>\n'
            f'\t\t<expression>{html.escape(expr)}</expression>\n'
            f'\t\t<title xsi:type="v8:LocalStringType">{loc(title)}</title>\n'
            '\t</calculatedField>')
    return "\n".join(out)


def resources():
    out = []
    for path, expr in RESOURCES:
        out.append(
            '\t<totalField>\n'
            f'\t\t<dataPath>{path}</dataPath>\n'
            f'\t\t<expression>{html.escape(expr)}</expression>\n'
            '\t</totalField>')
    return "\n".join(out)


def parameters():
    return f"""\t<parameter>
\t\t<name>СвойствоКоличествоДней</name>
\t\t<title xsi:type="v8:LocalStringType">{loc('Доп. реквизит "Количество дней"')}</title>
\t\t<valueType>
\t\t\t<v8:Type>cfg:ПланВидовХарактеристикСсылка.ДополнительныеРеквизитыИСведения</v8:Type>
\t\t</valueType>
\t\t<use>Always</use>
\t</parameter>
\t<parameter>
\t\t<name>НачалоПериода</name>
\t\t<title xsi:type="v8:LocalStringType">{loc('Начало периода')}</title>
\t\t<valueType>
\t\t\t<v8:Type>xs:dateTime</v8:Type>
\t\t\t<v8:DateQualifiers>
\t\t\t\t<v8:DateFractions>Date</v8:DateFractions>
\t\t\t</v8:DateQualifiers>
\t\t</valueType>
\t\t<value xsi:type="xs:dateTime">0001-01-01T00:00:00</value>
\t\t<use>Always</use>
\t</parameter>
\t<parameter>
\t\t<name>КонецПериода</name>
\t\t<title xsi:type="v8:LocalStringType">{loc('Конец периода')}</title>
\t\t<valueType>
\t\t\t<v8:Type>xs:dateTime</v8:Type>
\t\t\t<v8:DateQualifiers>
\t\t\t\t<v8:DateFractions>Date</v8:DateFractions>
\t\t\t</v8:DateQualifiers>
\t\t</valueType>
\t\t<value xsi:type="xs:dateTime">0001-01-01T00:00:00</value>
\t\t<use>Always</use>
\t</parameter>
\t<parameter>
\t\t<name>Статусы</name>
\t\t<title xsi:type="v8:LocalStringType">{loc('Статусы заказов')}</title>
\t\t<valueType>
\t\t\t<v8:Type>cfg:{STATUS_TYPE}</v8:Type>
\t\t</valueType>
\t\t<value xsi:type="v8:ValueListType">
\t\t\t<v8:item>
\t\t\t\t<v8:value xsi:type="cfg:{STATUS_TYPE}">Формируется</v8:value>
\t\t\t</v8:item>
\t\t\t<v8:item>
\t\t\t\t<v8:value xsi:type="cfg:{STATUS_TYPE}">КПроизводству</v8:value>
\t\t\t</v8:item>
\t\t</value>
\t\t<use>Always</use>
\t\t<valueListAllowed>true</valueListAllowed>
\t</parameter>"""


def group_item(field):
    return (f'\t\t\t\t\t<dcsset:item xsi:type="dcsset:GroupItemField">\n'
            f'\t\t\t\t\t\t<dcsset:field>{field}</dcsset:field>\n'
            f'\t\t\t\t\t\t<dcsset:groupType>Items</dcsset:groupType>\n'
            f'\t\t\t\t\t\t<dcsset:periodAdditionType>None</dcsset:periodAdditionType>\n'
            f'\t\t\t\t\t\t<dcsset:periodAdditionPeriod xsi:type="xs:dateTime">'
            f'0001-01-01T00:00:00</dcsset:periodAdditionPeriod>\n'
            f'\t\t\t\t\t</dcsset:item>')


def chart(status_value, title, with_fact):
    """Диаграмма Ганта: точки — заказы, серии — План/Факт,
    значение — два ресурса: начало и окончание интервала."""
    series_filter = "" if with_fact else f"""
\t\t\t\t\t<dcsset:filter>
\t\t\t\t\t\t<dcsset:item xsi:type="dcsset:FilterItemComparison">
\t\t\t\t\t\t\t<dcsset:use>true</dcsset:use>
\t\t\t\t\t\t\t<dcsset:left xsi:type="dcscor:Field">ЭтоФакт</dcsset:left>
\t\t\t\t\t\t\t<dcsset:comparisonType>Equal</dcsset:comparisonType>
\t\t\t\t\t\t\t<dcsset:right xsi:type="xs:boolean">false</dcsset:right>
\t\t\t\t\t\t</dcsset:item>
\t\t\t\t\t</dcsset:filter>"""
    return f"""\t\t\t<dcsset:item xsi:type="dcsset:StructureItemChart">
\t\t\t\t<dcsset:outputParameters>
\t\t\t\t\t<dcsset:item xsi:type="dcsset:SettingsParameterValue">
\t\t\t\t\t\t<dcsset:parameter>ТипДиаграммы</dcsset:parameter>
\t\t\t\t\t\t<dcsset:value xsi:type="v8ui:ChartType">GanttChart</dcsset:value>
\t\t\t\t\t</dcsset:item>
\t\t\t\t\t<dcsset:item xsi:type="dcsset:SettingsParameterValue">
\t\t\t\t\t\t<dcsset:parameter>Заголовок</dcsset:parameter>
\t\t\t\t\t\t<dcsset:value xsi:type="v8:LocalStringType">{loc(title)}</dcsset:value>
\t\t\t\t\t</dcsset:item>
\t\t\t\t\t<dcsset:item xsi:type="dcsset:SettingsParameterValue">
\t\t\t\t\t\t<dcsset:parameter>РасположениеЛегенды</dcsset:parameter>
\t\t\t\t\t\t<dcsset:value xsi:type="v8ui:ChartLegendPlacement">Bottom</dcsset:value>
\t\t\t\t\t</dcsset:item>
\t\t\t\t</dcsset:outputParameters>
\t\t\t\t<dcsset:filter>
\t\t\t\t\t<dcsset:item xsi:type="dcsset:FilterItemComparison">
\t\t\t\t\t\t<dcsset:use>true</dcsset:use>
\t\t\t\t\t\t<dcsset:left xsi:type="dcscor:Field">Статус</dcsset:left>
\t\t\t\t\t\t<dcsset:comparisonType>Equal</dcsset:comparisonType>
\t\t\t\t\t\t<dcsset:right xsi:type="cfg:{STATUS_TYPE}">{status_value}</dcsset:right>
\t\t\t\t\t</dcsset:item>
\t\t\t\t</dcsset:filter>
\t\t\t\t<dcsset:point>
\t\t\t\t<dcsset:item xsi:type="dcsset:StructureItemGroup">
\t\t\t\t\t<dcsset:groupItems>
{group_item('Заказ')}
\t\t\t\t\t</dcsset:groupItems>
\t\t\t\t\t<dcsset:order>
\t\t\t\t\t\t<dcsset:item xsi:type="dcsset:OrderItemField">
\t\t\t\t\t\t\t<dcsset:field>ДатаНачала</dcsset:field>
\t\t\t\t\t\t\t<dcsset:orderType>Asc</dcsset:orderType>
\t\t\t\t\t\t</dcsset:item>
\t\t\t\t\t</dcsset:order>
\t\t\t\t\t<dcsset:selection>
\t\t\t\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemAuto"/>
\t\t\t\t\t</dcsset:selection>
\t\t\t\t</dcsset:item>
\t\t\t\t</dcsset:point>
\t\t\t\t<dcsset:series>
\t\t\t\t<dcsset:item xsi:type="dcsset:StructureItemGroup">
\t\t\t\t\t<dcsset:groupItems>
{group_item('ВидИнтервала')}
\t\t\t\t\t</dcsset:groupItems>{series_filter}
\t\t\t\t\t<dcsset:order>
\t\t\t\t\t\t<dcsset:item xsi:type="dcsset:OrderItemField">
\t\t\t\t\t\t\t<dcsset:field>ПорядокВида</dcsset:field>
\t\t\t\t\t\t\t<dcsset:orderType>Asc</dcsset:orderType>
\t\t\t\t\t\t</dcsset:item>
\t\t\t\t\t</dcsset:order>
\t\t\t\t\t<dcsset:selection>
\t\t\t\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemAuto"/>
\t\t\t\t\t</dcsset:selection>
\t\t\t\t</dcsset:item>
\t\t\t\t</dcsset:series>
\t\t\t\t<dcsset:selection>
\t\t\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemField">
\t\t\t\t\t\t<dcsset:field>ДатаНачала</dcsset:field>
\t\t\t\t\t</dcsset:item>
\t\t\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemField">
\t\t\t\t\t\t<dcsset:field>ДатаОкончания</dcsset:field>
\t\t\t\t\t</dcsset:item>
\t\t\t\t</dcsset:selection>
\t\t\t</dcsset:item>"""


def table():
    """Расшифровка под диаграммами: строки — заказ / вид интервала."""
    return f"""\t\t\t<dcsset:item xsi:type="dcsset:StructureItemTable">
\t\t\t\t<dcsset:outputParameters>
\t\t\t\t\t<dcsset:item xsi:type="dcsset:SettingsParameterValue">
\t\t\t\t\t\t<dcsset:parameter>Заголовок</dcsset:parameter>
\t\t\t\t\t\t<dcsset:value xsi:type="v8:LocalStringType">{loc('Расшифровка план/факт')}</dcsset:value>
\t\t\t\t\t</dcsset:item>
\t\t\t\t</dcsset:outputParameters>
\t\t\t\t<dcsset:row>
\t\t\t\t<dcsset:item xsi:type="dcsset:StructureItemGroup">
\t\t\t\t\t<dcsset:groupItems>
{group_item('Статус')}
\t\t\t\t\t</dcsset:groupItems>
\t\t\t\t\t<dcsset:selection>
\t\t\t\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemAuto"/>
\t\t\t\t\t</dcsset:selection>
\t\t\t\t\t<dcsset:item xsi:type="dcsset:StructureItemGroup">
\t\t\t\t\t\t<dcsset:groupItems>
{group_item('Заказ')}
\t\t\t\t\t\t</dcsset:groupItems>
\t\t\t\t\t\t<dcsset:selection>
\t\t\t\t\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemAuto"/>
\t\t\t\t\t\t</dcsset:selection>
\t\t\t\t\t</dcsset:item>
\t\t\t\t</dcsset:item>
\t\t\t\t</dcsset:row>
\t\t\t\t<dcsset:column>
\t\t\t\t<dcsset:item xsi:type="dcsset:StructureItemGroup">
\t\t\t\t\t<dcsset:groupItems>
{group_item('ВидИнтервала')}
\t\t\t\t\t</dcsset:groupItems>
\t\t\t\t\t<dcsset:selection>
\t\t\t\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemAuto"/>
\t\t\t\t\t</dcsset:selection>
\t\t\t\t</dcsset:item>
\t\t\t\t</dcsset:column>
\t\t\t\t<dcsset:selection>
\t\t\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemField">
\t\t\t\t\t\t<dcsset:field>ДатаНачала</dcsset:field>
\t\t\t\t\t</dcsset:item>
\t\t\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemField">
\t\t\t\t\t\t<dcsset:field>ДатаОкончания</dcsset:field>
\t\t\t\t\t</dcsset:item>
\t\t\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemField">
\t\t\t\t\t\t<dcsset:field>ДлительностьДней</dcsset:field>
\t\t\t\t\t</dcsset:item>
\t\t\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemField">
\t\t\t\t\t\t<dcsset:field>КоличествоДнейПлан</dcsset:field>
\t\t\t\t\t</dcsset:item>
\t\t\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemField">
\t\t\t\t\t\t<dcsset:field>КоличествоЭтапов</dcsset:field>
\t\t\t\t\t</dcsset:item>
\t\t\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemField">
\t\t\t\t\t\t<dcsset:field>ЗавершеноЭтапов</dcsset:field>
\t\t\t\t\t</dcsset:item>
\t\t\t\t</dcsset:selection>
\t\t\t</dcsset:item>"""


def build():
    query = QUERY.read_text(encoding="utf-8")
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<DataCompositionSchema xmlns="http://v8.1c.ru/8.1/data-composition-system/schema" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:dcscor="http://v8.1c.ru/8.1/data-composition-system/core" xmlns:dcsset="http://v8.1c.ru/8.1/data-composition-system/settings" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
\t<dataSource>
\t\t<name>ИсточникДанных1</name>
\t\t<dataSourceType>Local</dataSourceType>
\t</dataSource>
\t<dataSet xsi:type="DataSetQuery">
\t\t<name>ЗаказыНаПроизводство</name>
{dataset_fields()}
\t\t<dataSource>ИсточникДанных1</dataSource>
\t\t<query>{html.escape(query)}</query>
\t</dataSet>
{calculated_fields()}
{resources()}
{parameters()}
\t<settingsVariant>
\t\t<dcsset:name>ПланФакт</dcsset:name>
\t\t<dcsset:presentation xsi:type="v8:LocalStringType">{loc('План / факт производства')}</dcsset:presentation>
\t\t<dcsset:settings xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
\t\t\t<dcsset:selection>
\t\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemAuto"/>
\t\t\t</dcsset:selection>
{chart('Формируется', 'Заказы на производство в статусе «Формируется» (план)', False)}
{chart('КПроизводству', 'Заказы на производство в статусе «К производству» (план / факт)', True)}
{table()}
\t\t\t<dcsset:outputParameters>
\t\t\t\t<dcsset:item xsi:type="dcsset:SettingsParameterValue">
\t\t\t\t\t<dcsset:parameter>ВыводитьПараметрыДанных</dcsset:parameter>
\t\t\t\t\t<dcsset:value xsi:type="dcscor:DataCompositionTextOutputType">Auto</dcsset:value>
\t\t\t\t</dcsset:item>
\t\t\t</dcsset:outputParameters>
\t\t</dcsset:settings>
\t</settingsVariant>
</DataCompositionSchema>
"""
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(xml, encoding="utf-8")
    print(f"written: {OUT.relative_to(ROOT)}  ({len(xml)} bytes)")


if __name__ == "__main__":
    build()
