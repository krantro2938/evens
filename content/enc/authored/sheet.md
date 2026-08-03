# Шпаргалка

## Таблица производных
$$(x^\alpha)' = \alpha x^{\alpha-1}, \quad (\sqrt{x})' = \frac{1}{2\sqrt{x}}$$
$$(e^x)' = e^x, \quad (a^x)' = a^x\ln a$$
$$(\ln x)' = \frac1x, \quad (\log_a x)' = \frac{1}{x\ln a}$$
$$(\sin x)' = \cos x, \quad (\cos x)' = -\sin x$$
$$(\operatorname{tg} x)' = \frac{1}{\cos^2 x}, \quad (\operatorname{ctg} x)' = -\frac{1}{\sin^2 x}$$
$$(\arcsin x)' = \frac{1}{\sqrt{1-x^2}}, \quad (\arccos x)' = -\frac{1}{\sqrt{1-x^2}}$$
$$(\operatorname{arctg} x)' = \frac{1}{1+x^2}, \quad (\operatorname{arcctg} x)' = -\frac{1}{1+x^2}$$
- $(uv)'=u'v+uv'$, $\left(\dfrac{u}{v}\right)'=\dfrac{u'v-uv'}{v^2}$, $(f(g))'=f'(g)g'$

## Таблица интегралов
$$\int x^\alpha dx = \frac{x^{\alpha+1}}{\alpha+1}+C, \quad \int \frac{dx}{x}=\ln|x|+C$$
$$\int e^x dx = e^x+C, \quad \int a^x dx = \frac{a^x}{\ln a}+C$$
$$\int \sin x\,dx = -\cos x+C, \quad \int \cos x\,dx = \sin x+C$$
$$\int \frac{dx}{\cos^2 x} = \operatorname{tg} x+C, \quad \int \frac{dx}{\sin^2 x} = -\operatorname{ctg} x+C$$
$$\int \frac{dx}{\sqrt{a^2-x^2}} = \arcsin\frac{x}{a}+C$$
$$\int \frac{dx}{a^2+x^2} = \frac1a\operatorname{arctg}\frac{x}{a}+C$$
$$\int \frac{dx}{x^2-a^2} = \frac{1}{2a}\ln\left|\frac{x-a}{x+a}\right|+C$$
$$\int \frac{dx}{\sqrt{x^2\pm a^2}} = \ln\left|x+\sqrt{x^2\pm a^2}\right|+C$$
$$\int u\,dv = uv-\int v\,du$$ (по частям)

## Эквивалентные бесконечно малые ($x\to0$)
$$\sin x \sim x, \quad \operatorname{tg} x \sim x, \quad \arcsin x \sim x, \quad \operatorname{arctg} x \sim x$$
$$1-\cos x \sim \frac{x^2}{2}, \quad \ln(1+x)\sim x, \quad e^x-1\sim x$$
$$a^x-1\sim x\ln a, \quad (1+x)^\alpha-1\sim \alpha x$$

## Замечательные пределы
$$\lim_{x\to0}\frac{\sin x}{x}=1, \quad \lim_{x\to\infty}\left(1+\frac1x\right)^x = e$$

## Ряды Маклорена
$$e^x = \sum_{n=0}^\infty \frac{x^n}{n!}$$
$$\sin x = \sum_{n=0}^\infty \frac{(-1)^n x^{2n+1}}{(2n+1)!} = x-\frac{x^3}{6}+\frac{x^5}{120}-\dots$$
$$\cos x = \sum_{n=0}^\infty \frac{(-1)^n x^{2n}}{(2n)!} = 1-\frac{x^2}{2}+\frac{x^4}{24}-\dots$$
$$\ln(1+x) = \sum_{n=1}^\infty \frac{(-1)^{n-1}x^n}{n} = x-\frac{x^2}{2}+\frac{x^3}{3}-\dots$$
$$\frac{1}{1-x} = \sum_{n=0}^\infty x^n, \quad (1+x)^\alpha = \sum_{n=0}^\infty \binom{\alpha}{n}x^n$$

## Тригонометрия — то, что забывают
$$\sin^2 x+\cos^2 x = 1, \quad 1+\operatorname{tg}^2 x = \frac{1}{\cos^2 x}$$
$$\sin 2x = 2\sin x\cos x, \quad \cos 2x = \cos^2x-\sin^2x = 2\cos^2x-1 = 1-2\sin^2x$$
$$\operatorname{tg} 2x = \frac{2\operatorname{tg} x}{1-\operatorname{tg}^2 x}$$
$$\sin^2 x = \frac{1-\cos 2x}{2}, \quad \cos^2 x = \frac{1+\cos 2x}{2}$$
$$\sin x + \sin y = 2\sin\frac{x+y}{2}\cos\frac{x-y}{2}$$
$$\sin x - \sin y = 2\cos\frac{x+y}{2}\sin\frac{x-y}{2}$$
$$\cos x + \cos y = 2\cos\frac{x+y}{2}\cos\frac{x-y}{2}$$
$$\cos x - \cos y = -2\sin\frac{x+y}{2}\sin\frac{x-y}{2}$$
$$\sin x\cos y = \frac12\big(\sin(x+y)+\sin(x-y)\big)$$
$$\cos x\cos y = \frac12\big(\cos(x-y)+\cos(x+y)\big)$$
$$\sin x\sin y = \frac12\big(\cos(x-y)-\cos(x+y)\big)$$
$$\sin(x\pm y) = \sin x\cos y \pm \cos x\sin y$$
$$\cos(x\pm y) = \cos x\cos y \mp \sin x\sin y$$

## Универсальная подстановка
$$t=\operatorname{tg}\frac x2:\quad \sin x=\frac{2t}{1+t^2},\ \cos x=\frac{1-t^2}{1+t^2},\ dx=\frac{2\,dt}{1+t^2}$$

## Формула Ньютона — Лейбница
$$\int_a^b f(x)\,dx = F(b)-F(a)$$

## Формула Эйлера
$$e^{i\varphi} = \cos\varphi+i\sin\varphi, \quad e^{i\pi}+1=0$$
