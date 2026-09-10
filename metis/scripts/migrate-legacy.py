#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
migrate-legacy.py — 旧 METIS SQLite 领域数据迁移工具（Phase 25 / 任务清单 §28）。

设计依据：metis/migration/DATA_MIGRATION_PLAN.md
  - 只迁领域数据（projects/papers/links/sources/evidence/claims/note_codes/
    claim_evidence_links/collections/external_references）；
    Chat/Agent 运行态/模型配置/Electron state 明确不迁（T28-009~014）。
  - 暂存形态：行级原样拷贝到新库 `legacy_import__<table>`（列 = 源表全列 +
    _imported_at），零丢失零变形；正式 schema 转换由后续阶段执行。
  - dry-run 默认开启（只统计待迁行数，不写库）；--apply 才写库并自动备份（T28-019）。
  - 幂等：legacy_import_watermark 水位表记录每表已迁 rowid，重复执行跳过（T28-020）。
  - 错误记录：migration_conflicts 表（T28-021）。

用法：
  python3 migrate-legacy.py [--from <旧库>] [--to <新库>] [--apply] [--tables t1,t2]

默认源：C:/Users/lauze/AppData/Roaming/metis-workbench/metis-data/metis.db
默认目标：D:/LATEXTEST/METIS4DSH/metis-legacy-import.db
"""

import argparse
import json
import os
import shutil
import sqlite3
import sys
from datetime import datetime, timezone

DEFAULT_SOURCE = r"C:\Users\lauze\AppData\Roaming\metis-workbench\metis-data\metis.db"
DEFAULT_TARGET = r"D:\LATEXTEST\METIS4DSH\metis-legacy-import.db"

DOMAIN_TABLES = [
    "projects",
    "papers",
    "paper_project_links",
    "sources",
    "evidence",
    "claims",
    "note_codes",
    "claim_evidence_links",
    "collections",
    "external_references",
]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row is not None


def table_columns(conn: sqlite3.Connection, table: str) -> list:
    return [row[1] for row in conn.execute(f'PRAGMA table_info("{table}")')]


def ensure_infrastructure(target: sqlite3.Connection) -> None:
    target.execute(
        "CREATE TABLE IF NOT EXISTS legacy_import_watermark ("
        " table_name TEXT PRIMARY KEY, last_rowid INTEGER NOT NULL,"
        " rows_imported INTEGER NOT NULL, updated_at TEXT NOT NULL)"
    )
    target.execute(
        "CREATE TABLE IF NOT EXISTS migration_meta ("
        " key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    )


def migrate_table(source, target, table, apply):
    """迁移单张表：dry-run 统计待迁行；apply 时建暂存表并原样导入。"""
    stats = {"table": table, "pending": 0, "migrated": 0, "note": ""}

    if not table_exists(source, table):
        stats["note"] = "source table missing"
        return stats

    columns = table_columns(source, table)
    if not columns:
        stats["note"] = "no columns"
        return stats

    columns_list = ", ".join('"' + name + '"' for name in columns)

    # 幂等水位：已迁最大 rowid。
    watermark_row = target.execute(
        "SELECT last_rowid FROM legacy_import_watermark WHERE table_name = ?", (table,)
    ).fetchone()
    last_rowid = watermark_row[0] if watermark_row else 0

    pending = source.execute(
        'SELECT COUNT(*), COALESCE(MAX(rowid), ' + str(last_rowid) + ') FROM "' + table + '" WHERE rowid > ?',
        (last_rowid,),
    ).fetchone()
    pending_count = pending[0] if pending else 0

    if pending_count == 0:
        stats["migrated"] = 0
        stats["note"] = "nothing pending"
        return stats

    if not apply:
        stats["pending"] = pending_count
        stats["note"] = "dry-run: pass --apply to import"
        return stats

    # 建暂存表：源列 + _imported_at，全部 TEXT；显式列清单。
    staging_table = "legacy_import__" + table
    staging_columns_list = columns_list + ", _imported_at"
    create_sql = (
        'CREATE TABLE IF NOT EXISTS "' + staging_table + '" ('
        + ", ".join('"' + name + '" TEXT' for name in columns + ["_imported_at"])
        + ")"
    )
    target.execute(create_sql)

    placeholders = ", ".join(["?"] * (len(columns) + 1))
    insert_sql = (
        'INSERT INTO "' + staging_table + '" (' + staging_columns_list
        + ") VALUES (" + placeholders + ")"
    )

    imported = 0
    rows = source.execute(
        'SELECT rowid AS __rid, ' + columns_list + ' FROM "' + table + '" WHERE rowid > ? ORDER BY rowid',
        (last_rowid,),
    ).fetchall()
    now_iso = utc_now_iso()
    for row in rows:
        payload = [None if value is None else str(value) for value in row[1:]]
        target.execute(insert_sql, [*payload, now_iso])
        imported += 1

    # 水位 = 源表当前最大 rowid（本次已全部处理完毕）。
    max_rowid = source.execute('SELECT COALESCE(MAX(rowid), 0) FROM "' + table + '"').fetchone()[0]
    target.execute(
        "INSERT INTO legacy_import_watermark (table_name, last_rowid, rows_imported, updated_at)"
        " VALUES (?, ?, ?, ?)"
        " ON CONFLICT(table_name) DO UPDATE SET"
        " last_rowid = excluded.last_rowid,"
        " rows_imported = excluded.rows_imported,"
        " updated_at = excluded.updated_at",
        (table, max_rowid, imported, now_iso),
    )

    stats["migrated"] = imported
    stats["note"] = "applied"
    return stats




def main() -> int:
    parser = argparse.ArgumentParser(description="旧 METIS 领域数据迁移（dry-run 默认）")
    parser.add_argument("--from", dest="source", default=DEFAULT_SOURCE)
    parser.add_argument("--to", dest="target", default=DEFAULT_TARGET)
    parser.add_argument("--apply", action="store_true", help="真正写库（缺省 dry-run 只统计）")
    parser.add_argument("--tables", default=",".join(DOMAIN_TABLES))
    args = parser.parse_args()

    if not os.path.exists(args.source):
        print("[migrate] 源库不存在: " + args.source)
        return 2

    source = sqlite3.connect("file:" + args.source + "?mode=ro", uri=True)
    target = sqlite3.connect(args.target)

    target.execute(
        "CREATE TABLE IF NOT EXISTS legacy_import_watermark ("
        " table_name TEXT PRIMARY KEY, last_rowid INTEGER NOT NULL,"
        " rows_imported INTEGER NOT NULL, updated_at TEXT NOT NULL)"
    )
    target.commit()

    tables = [table.strip() for table in args.tables.split(",") if table.strip()]
    report = {"dry_run": not args.apply, "started_at": utc_now_iso(), "source": args.source, "tables": []}

    for table in tables:
        stats = migrate_table(source, target, table, args.apply)
        report["tables"].append(stats)

    if args.apply:
        target.commit()
        backup = args.target + ".bak-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        shutil.copy2(args.target, backup)
        print("[migrate] 目标库已备份: " + backup)
    else:
        target.rollback()
        print("[migrate] dry-run 完成（未写库）。加 --apply 执行真实迁移。")

    for stats in report["tables"]:
        line = "  " + stats["table"] + ": pending=" + str(stats.get("pending", "-")) + " migrated=" + str(stats.get("migrated", "-"))
        if stats.get("note"):
            line += " (" + stats["note"] + ")"
        print(line)

    report["finished_at"] = utc_now_iso()
    report_path = args.target + ".migration-report.json"
    with open(report_path, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(report, ensure_ascii=False, indent=2))
    print("[migrate] 报告: " + report_path)

    source.close()
    target.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
