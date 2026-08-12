'use client';

import Link from 'next/link';
import { LanguageSwitcher } from '@/components/language-switcher';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useI18n } from '@/lib/hooks/use-i18n';

type Task = {
  id: string;
  title: string | null;
  description: string | null;
  share_token: string | null;
  due_at: string | null;
};

type Copy = {
  title: string;
  welcome: string;
  intro: string;
  empty: string;
  emptyHint: string;
  due: string;
  start: string;
  untitled: string;
};

const copy: Record<string, Copy> = {
  'zh-CN': {
    title: '\u6211\u7684\u5b66\u4e60\u4efb\u52a1',
    welcome: '\u6b22\u8fce\uff0c',
    intro:
      '\u3002\u8fd9\u91cc\u5c55\u793a\u8001\u5e08\u5206\u914d\u7ed9\u4f60\u7684\u5b66\u4e60\u4efb\u52a1\u3002',
    empty: '\u6682\u65e0\u5b66\u4e60\u4efb\u52a1',
    emptyHint:
      '\u8001\u5e08\u53d1\u5e03\u5e76\u5c06\u4f60\u52a0\u5165\u4efb\u52a1\u540e\uff0c\u4f1a\u5728\u8fd9\u91cc\u663e\u793a\u3002',
    due: '\u622a\u6b62\uff1a',
    start: '\u8fdb\u5165\u5b66\u4e60',
    untitled: '\u672a\u547d\u540d\u4efb\u52a1',
  },
  'zh-TW': {
    title: '\u6211\u7684\u5b78\u7fd2\u4efb\u52d9',
    welcome: '\u6b61\u8fce\uff0c',
    intro:
      '\u3002\u9019\u88e1\u986f\u793a\u8001\u5e2b\u5206\u914d\u7d66\u4f60\u7684\u5b78\u7fd2\u4efb\u52d9\u3002',
    empty: '\u66ab\u7121\u5b78\u7fd2\u4efb\u52d9',
    emptyHint:
      '\u8001\u5e2b\u767c\u5e03\u4e26\u5c07\u4f60\u52a0\u5165\u4efb\u52d9\u5f8c\uff0c\u6703\u5728\u9019\u88e1\u986f\u793a\u3002',
    due: '\u622a\u6b62\uff1a',
    start: '\u958b\u59cb\u5b78\u7fd2',
    untitled: '\u672a\u547d\u540d\u4efb\u52d9',
  },
  'en-US': {
    title: 'My learning tasks',
    welcome: 'Welcome, ',
    intro: '. Your assigned tasks appear here.',
    empty: 'No learning tasks yet',
    emptyHint: 'Tasks appear here after your teacher assigns you.',
    due: 'Due: ',
    start: 'Start learning',
    untitled: 'Untitled task',
  },
  'ja-JP': {
    title: '\u5b66\u7fd2\u30bf\u30b9\u30af',
    welcome: '\u3088\u3046\u3053\u305d\u3001',
    intro:
      '\u3002\u5272\u308a\u5f53\u3066\u3089\u308c\u305f\u5b66\u7fd2\u30bf\u30b9\u30af\u3067\u3059\u3002',
    empty: '\u5b66\u7fd2\u30bf\u30b9\u30af\u306f\u3042\u308a\u307e\u305b\u3093',
    emptyHint:
      '\u5148\u751f\u304c\u30bf\u30b9\u30af\u3092\u5272\u308a\u5f53\u3066\u308b\u3068\u3001\u3053\u3053\u306b\u8868\u793a\u3055\u308c\u307e\u3059\u3002',
    due: '\u671f\u9650\uff1a',
    start: '\u5b66\u7fd2\u3092\u59cb\u3081\u308b',
    untitled: '\u7121\u984c\u306e\u30bf\u30b9\u30af',
  },
  'ru-RU': {
    title:
      '\u041c\u043e\u0438 \u0443\u0447\u0435\u0431\u043d\u044b\u0435 \u0437\u0430\u0434\u0430\u043d\u0438\u044f',
    welcome: '\u0417\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439\u0442\u0435, ',
    intro:
      '. \u0417\u0434\u0435\u0441\u044c \u043f\u043e\u043a\u0430\u0437\u0430\u043d\u044b \u043d\u0430\u0437\u043d\u0430\u0447\u0435\u043d\u043d\u044b\u0435 \u0432\u0430\u043c \u0437\u0430\u0434\u0430\u043d\u0438\u044f.',
    empty:
      '\u0423\u0447\u0435\u0431\u043d\u044b\u0445 \u0437\u0430\u0434\u0430\u043d\u0438\u0439 \u043f\u043e\u043a\u0430 \u043d\u0435\u0442',
    emptyHint:
      '\u0417\u0430\u0434\u0430\u043d\u0438\u044f \u043f\u043e\u044f\u0432\u044f\u0442\u0441\u044f \u0437\u0434\u0435\u0441\u044c \u043f\u043e\u0441\u043b\u0435 \u043d\u0430\u0437\u043d\u0430\u0447\u0435\u043d\u0438\u044f \u043f\u0440\u0435\u043f\u043e\u0434\u0430\u0432\u0430\u0442\u0435\u043b\u0435\u043c.',
    due: '\u0421\u0440\u043e\u043a: ',
    start: '\u041d\u0430\u0447\u0430\u0442\u044c \u043e\u0431\u0443\u0447\u0435\u043d\u0438\u0435',
    untitled:
      '\u0417\u0430\u0434\u0430\u043d\u0438\u0435 \u0431\u0435\u0437 \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u044f',
  },
  'ar-SA': {
    title: '\u0645\u0647\u0627\u0645 \u0627\u0644\u062a\u0639\u0644\u0645',
    welcome: '\u0645\u0631\u062d\u0628\u064b\u0627\u060c ',
    intro:
      '. \u062a\u0638\u0647\u0631 \u0645\u0647\u0627\u0645\u0643 \u0627\u0644\u0645\u0639\u064a\u0651\u0646\u0629 \u0647\u0646\u0627.',
    empty:
      '\u0644\u0627 \u062a\u0648\u062c\u062f \u0645\u0647\u0627\u0645 \u062a\u0639\u0644\u064a\u0645\u064a\u0629 \u0628\u0639\u062f',
    emptyHint:
      '\u0633\u062a\u0638\u0647\u0631 \u0627\u0644\u0645\u0647\u0627\u0645 \u0647\u0646\u0627 \u0628\u0639\u062f \u0623\u0646 \u064a\u0639\u064a\u0651\u0646\u0647\u0627 \u0627\u0644\u0645\u0639\u0644\u0645.',
    due: '\u0627\u0644\u0645\u0648\u0639\u062f: ',
    start: '\u0628\u062f\u0621 \u0627\u0644\u062a\u0639\u0644\u0645',
    untitled: '\u0645\u0647\u0645\u0629 \u0628\u0644\u0627 \u0639\u0646\u0648\u0627\u0646',
  },
  'pt-BR': {
    title: 'Minhas tarefas de aprendizagem',
    welcome: 'Ol\u00e1, ',
    intro: '. Suas tarefas atribu\u00eddas aparecem aqui.',
    empty: 'Ainda n\u00e3o h\u00e1 tarefas',
    emptyHint: 'As tarefas aparecer\u00e3o aqui ap\u00f3s a atribui\u00e7\u00e3o do professor.',
    due: 'Prazo: ',
    start: 'Iniciar aprendizagem',
    untitled: 'Tarefa sem t\u00edtulo',
  },
  'ko-KR': {
    title: '\ub0b4 \ud559\uc2b5 \uacfc\uc81c',
    welcome: '\ud658\uc601\ud569\ub2c8\ub2e4, ',
    intro: '\ub2d8. \ubc30\uc815\ub41c \ud559\uc2b5 \uacfc\uc81c\uc785\ub2c8\ub2e4.',
    empty: '\ud559\uc2b5 \uacfc\uc81c\uac00 \uc5c6\uc2b5\ub2c8\ub2e4',
    emptyHint:
      '\uc120\uc0dd\ub2d8\uc774 \uacfc\uc81c\ub97c \ubc30\uc815\ud558\uba74 \uc5ec\uae30\uc5d0 \ud45c\uc2dc\ub429\ub2c8\ub2e4.',
    due: '\ub9c8\uac10: ',
    start: '\ud559\uc2b5 \uc2dc\uc791',
    untitled: '\uc81c\ubaa9 \uc5c6\ub294 \uacfc\uc81c',
  },
};

export function StudentCoursesView({ studentName, tasks }: { studentName: string; tasks: Task[] }) {
  const { locale } = useI18n();
  const text = copy[locale] ?? copy['zh-CN'];

  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{text.title}</h1>
            <p className="text-sm text-muted-foreground">
              {text.welcome}
              {studentName}
              {text.intro}
            </p>
          </div>
          <LanguageSwitcher />
        </header>
        {tasks.length === 0 ? (
          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle>{text.empty}</CardTitle>
              <CardDescription>{text.emptyHint}</CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="space-y-3">
            {tasks.map((task) => (
              <Card key={task.id} className="rounded-lg">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{task.title || text.untitled}</CardTitle>
                  {task.description && (
                    <CardDescription className="line-clamp-2">{task.description}</CardDescription>
                  )}
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-3">
                  {task.due_at && (
                    <span className="text-xs text-muted-foreground">
                      {text.due}
                      {new Date(task.due_at).toLocaleString(locale)}
                    </span>
                  )}
                  <div className="ml-auto">
                    <Button asChild size="sm">
                      <Link href={`/learn/${task.share_token}`}>{text.start}</Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
