/* Painel de Crédito — sem bibliotecas, feito para abrir rápido no celular.
 * Estratégia de velocidade: o "esqueleto" aparece na hora; cada tela mostra o último resultado guardado no aparelho
 * e atualiza por trás (stale-while-revalidate); a tela inicial usa UMA chamada à API. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  var state = { user: null, cfg: null, rota: 0 };

  // ------------------------------------------------------------------ utilidades
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(v) { return BRL.format(Number(v || 0)); }
  function dataBr(ymd) { return ymd ? String(ymd).slice(0, 10).split('-').reverse().join('/') : ''; }
  function hojeYmd() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()); }
  function amanhaYmd() { var d = new Date(hojeYmd() + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
  /** Valor digitado → número. Com vírgula, o ponto é milhar ("1.234,56"); sem vírgula, o ponto é decimal ("122.80"). */
  function parseValor(txt) {
    var t = String(txt == null ? '' : txt).trim().replace(/[^\d.,-]/g, '');
    if (t.indexOf(',') >= 0) t = t.replace(/\./g, '').replace(',', '.');
    var n = parseFloat(t); return isNaN(n) ? NaN : n;
  }
  function digitos(s) { return String(s || '').replace(/\D/g, ''); }

  var ST_CONTRATO = { DRAFT: ['Rascunho', 'gray'], AWAITING_SIGNATURE: ['Aguardando assinatura', 'warn'], SIGNED: ['Assinado', 'info'], ACTIVE: ['Em andamento', 'ok'], PAID: ['Quitado', 'ok'], DEFAULTED: ['Inadimplente', 'err'], CANCELLED: ['Cancelado', 'gray'] };
  var ST_PARCELA = { PENDING: ['A vencer', 'gray'], PARTIAL: ['Parcial', 'warn'], PAID: ['Paga', 'ok'], OVERDUE: ['Atrasada', 'err'], WAIVED: ['Perdoada', 'gray'] };
  var ST_CLIENTE = { LEAD: ['Novo', 'gray'], ATIVO: ['Ativo', 'info'], EM_DIA: ['Em dia', 'ok'], ATRASADO: ['Atrasado', 'warn'], INADIMPLENTE: ['Inadimplente', 'err'], BLOQUEADO: ['Bloqueado', 'err'] };
  function chip(mapa, st) { var m = mapa[st] || [st, 'gray']; return '<span class="chip ' + m[1] + '">' + esc(m[0]) + '</span>'; }

  var toastTimer;
  function toast(msg, erro) { var t = $('toast'); t.textContent = msg; t.className = 'on' + (erro ? ' err' : ''); clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = ''; }, erro ? 6000 : 3500); }
  function abrirModal(html) { $('modalCorpo').innerHTML = html; $('modal').classList.add('on'); }
  function fecharModal() { $('modal').classList.remove('on'); $('modalCorpo').innerHTML = ''; }
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) fecharModal(); });

  // ------------------------------------------------------------------ cache local (some ao sair)
  function lerCache(k) { try { var v = localStorage.getItem('mc:' + k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function gravarCache(k, v) { try { localStorage.setItem('mc:' + k, JSON.stringify(v)); } catch (e) { /* sem espaço: segue sem cache */ } }
  /** Apaga os dados guardados (depois de qualquer alteração). Mantém só a marca de que o aparelho já estava logado. */
  function limparCaches() { try { Object.keys(localStorage).filter(function (k) { return k.indexOf('mc:') === 0 && k !== 'mc:logado'; }).forEach(function (k) { localStorage.removeItem(k); }); } catch (e) { /* nada */ } }

  // ------------------------------------------------------------------ login (Firebase)
  var auth = null, resolverAuth, authPronto = new Promise(function (ok) { resolverAuth = ok; });
  function iniciarFirebase() {
    var cfg = window.__FB || {};
    if (!window.firebase || !cfg.apiKey) return false;
    window.firebase.initializeApp(cfg);
    auth = window.firebase.auth();
    return true;
  }
  function getToken() {
    // Espera o Firebase terminar de restaurar o login (na abertura, isso leva uma fração de segundo).
    return authPronto.then(function () {
      if (!auth || !auth.currentUser) throw new Error('Faça login para continuar.');
      return auth.currentUser.getIdToken();
    });
  }

  function api(path, opts) {
    opts = opts || {};
    return getToken().then(function (token) {
      var headers = { authorization: 'Bearer ' + token };
      if (opts.body !== undefined) headers['content-type'] = 'application/json';
      return fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) { sair(); throw new Error('Sua sessão expirou. Entre de novo.'); }
        if (r.status === 403 && j.error === 'forbidden') throw new Error('Este e-mail não está autorizado como operador.');
        if (r.status === 403 && j.error === 'admin_only') throw new Error('Só o administrador pode fazer isso.');
        if (!r.ok) { var e = new Error(j.message || 'Não foi possível concluir (erro ' + r.status + ').'); e.dados = j; throw e; }
        return j;
      });
    });
  }

  function mostrarLogin(msg) {
    $('carregandoInicial').classList.add('hide'); $('shell').classList.add('hide'); $('login').classList.remove('hide');
    var m = $('loginMsg'); m.textContent = msg || ''; m.classList.toggle('hide', !msg);
  }
  function mostrarShell() { $('carregandoInicial').classList.add('hide'); $('login').classList.add('hide'); $('shell').classList.remove('hide'); }

  function entrar() {
    if (!auth) { mostrarLogin('A configuração do login está incompleta. Avise o administrador do sistema.'); return; }
    var provider = new window.firebase.auth.GoogleAuthProvider();
    $('btnEntrar').disabled = true;
    auth.signInWithPopup(provider).catch(function (e) {
      if (e && e.code === 'auth/popup-blocked') return auth.signInWithRedirect(provider);
      var msg = e && e.code === 'auth/unauthorized-domain' ? 'Este endereço ainda não foi liberado no Firebase (Authentication → Configurações → Domínios autorizados).'
        : e && e.code === 'auth/popup-closed-by-user' ? '' : 'Não foi possível entrar: ' + ((e && e.message) || 'erro desconhecido');
      mostrarLogin(msg);
    }).then(function () { $('btnEntrar').disabled = false; });
  }
  function sair() {
    limparCaches(); try { localStorage.removeItem('mc:logado'); } catch (e) { /* nada */ }
    state.cfg = null;
    if (auth) auth.signOut().catch(function () { /* nada */ });
    mostrarLogin('');
  }

  // ------------------------------------------------------------------ stale-while-revalidate
  function swr(chave, path, render, token) {
    var antigo = lerCache(chave);
    if (antigo) render(antigo, true);
    return api(path).then(function (novo) {
      gravarCache(chave, novo);
      if (token !== state.rota) return novo;
      if (!antigo || JSON.stringify(antigo) !== JSON.stringify(novo)) render(novo, false);
      return novo;
    }).catch(function (e) {
      if (token !== state.rota) return;
      if (antigo) { toast('Sem conexão com o servidor: mostrando os últimos dados salvos.', true); return; }
      $('app').innerHTML = '<div class="msg err">' + esc(e.message) + '</div><button class="btn sec" id="tentar">Tentar de novo</button>';
      var b = $('tentar'); if (b) b.onclick = rota;
    });
  }
  function esqueleto() { $('app').innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>'; }

  // ------------------------------------------------------------------ rotas
  function rota() {
    var token = ++state.rota;
    $('app').onclick = null; $('app').oninput = null;
    var partes = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    var tela = partes[0] || 'inicio';
    var links = document.querySelectorAll('#nav a');
    for (var i = 0; i < links.length; i++) links[i].classList.toggle('on', links[i].getAttribute('data-r') === tela);
    window.scrollTo(0, 0);
    var v;
    if (tela === 'inicio') v = telaInicio;
    else if (tela === 'cobrancas') v = telaCobrancas;
    else if (tela === 'clientes' && partes[1] === 'novo') v = telaClienteNovo;
    else if (tela === 'clientes' && partes[1] && partes[2] === 'contrato') v = telaContratoNovo;
    else if (tela === 'clientes' && partes[1]) v = telaCliente;
    else if (tela === 'clientes') v = telaClientes;
    else if (tela === 'contratos' && partes[1]) v = telaContrato;
    else if (tela === 'contratos') v = telaContratos;
    else if (tela === 'caixa') v = telaCaixa;
    else if (tela === 'config') v = telaConfig;
    else v = telaInicio;
    $('titulo').textContent = (state.cfg && state.cfg.settings && state.cfg.settings.companyName) || 'Painel de Crédito';
    v(partes, token);
  }

  // ------------------------------------------------------------------ INÍCIO
  function telaInicio(_p, token) {
    esqueleto();
    swr('inicio', '/api/credito/inicio', function (d) {
      if (token !== state.rota) return;
      var p = d.painel, g = d.gestor, c = g.caixa, s = g.saude;
      var h = '<h2>Visão geral</h2>';
      h += '<div class="grid">';
      h += '<div class="kpi destaque"><small>Disponível para emprestar</small><b>' + money(c.disponivelParaEmprestar) + '</b></div>';
      h += '<div class="kpi"><small>Saldo em caixa</small><b>' + money(c.saldoCaixa) + '</b></div>';
      h += '<div class="kpi"><small>Na rua (capital)</small><b>' + money(p.principalOut) + '</b></div>';
      h += '<div class="kpi"><small>A receber</small><b>' + money(p.outstanding) + '</b></div>';
      h += '<div class="kpi"><small>Recebido hoje</small><b>' + money(p.receivedToday) + '</b></div>';
      h += '<div class="kpi"><small>Vence hoje</small><b>' + money(p.dueToday) + '</b></div>';
      h += '<div class="kpi"><small>Parcelas atrasadas</small><b>' + esc(p.overdueInstallments) + '</b></div>';
      h += '</div>';
      var cor = s.semaforo === 'VERDE' ? 'ok' : s.semaforo === 'AMARELO' ? 'warn' : 'err';
      h += '<div class="msg ' + cor + '"><b>Carteira ' + esc(s.semaforo.toLowerCase()) + '.</b> ' + esc((s.frases && s.frases[0]) || '') + '</div>';
      if (g.tarefas && g.tarefas.length) {
        h += '<div class="card"><h3>O que fazer hoje</h3>';
        g.tarefas.slice(0, 6).forEach(function (t) {
          h += '<div class="item"><b>' + esc(t.titulo) + '</b><div class="muted small">' + esc(t.detalhe) + '</div></div>';
        });
        h += '</div>';
      }
      h += '<div class="acoes"><a class="btn" href="#/clientes/novo">+ Novo cliente</a><a class="btn sec" href="#/cobrancas">Cobranças de hoje</a></div>';
      $('app').innerHTML = h;
    }, token);
  }

  // ------------------------------------------------------------------ COBRANÇAS + BAIXA
  function telaCobrancas(_p, token) {
    esqueleto();
    var linhas = [];
    function desenhar(d) {
      if (token !== state.rota) return;
      var t = d.totals;
      var h = '<h2>Cobranças</h2><div class="grid">';
      h += '<div class="kpi"><small>Vencem hoje (' + t.hoje + ')</small><b>' + money(t.valorHoje) + '</b></div>';
      h += '<div class="kpi"><small>Atrasadas (' + t.atrasadas + ')</small><b>' + money(t.valorAtrasado) + '</b></div></div>';
      if (!linhas.length) h += '<div class="card center muted">Nenhuma cobrança para hoje. 🎉</div>';
      linhas.forEach(function (r) {
        var nome = r.borrower.tradeName || r.borrower.name;
        h += '<div class="card"><div class="row"><div><b>' + esc(nome) + '</b><div class="muted small">' + esc(r.contractNumber) + ' · parcela ' + r.sequence + '/' + r.installmentsCount + ' · vence ' + dataBr(r.dueDate) + '</div></div>';
        h += '<div class="right"><b>' + money(r.totalDue) + '</b><div>' + (r.lateDays > 0 ? '<span class="chip err">' + r.lateDays + ' dia' + (r.lateDays > 1 ? 's' : '') + ' de atraso</span>' : '<span class="chip">Hoje</span>') + '</div></div></div>';
        h += '<div class="acoes"><button class="btn sm" data-baixa="' + esc(r.installmentId) + '" data-valor="' + esc(r.totalDue) + '" data-nome="' + esc(nome) + '" data-seq="' + r.sequence + '">Dar baixa</button>';
        h += '<a class="btn sm sec" target="_blank" rel="noopener" href="' + esc(r.whatsappLink) + '">WhatsApp</a>';
        h += '<a class="btn sm sec" href="#/contratos/' + esc(r.contractId) + '">Contrato</a></div></div>';
      });
      if (d.hasMore) h += '<button class="btn sec full" id="maisCobr">Carregar mais</button>';
      $('app').innerHTML = h;
      var mais = $('maisCobr');
      if (mais) mais.onclick = function () { mais.disabled = true; carregar(linhas.length); };
    }
    function carregar(offset) {
      return api('/api/credito/cobrancas?limit=40&offset=' + offset).then(function (d) {
        if (token !== state.rota) return;
        linhas = offset === 0 ? d.rows : linhas.concat(d.rows);
        desenhar(d);
        if (offset === 0) gravarCache('cobrancas', d);
      }).catch(function (e) { toast(e.message, true); });
    }
    var antigo = lerCache('cobrancas');
    if (antigo) { linhas = antigo.rows; desenhar(antigo); }
    carregar(0);
    $('app').onclick = function (e) {
      var b = e.target.closest('[data-baixa]');
      if (b) abrirBaixa(b.getAttribute('data-baixa'), b.getAttribute('data-valor'), b.getAttribute('data-nome') + ' · parcela ' + b.getAttribute('data-seq'), function () { carregar(0); });
    };
  }

  function abrirBaixa(parcelaId, valorSugerido, titulo, aoConcluir) {
    abrirModal('<h3>Dar baixa — ' + esc(titulo) + '</h3>' +
      '<form id="fBaixa"><label>Valor recebido (R$)</label><input name="valor" inputmode="decimal" value="' + esc(String(Number(valorSugerido || 0).toFixed(2)).replace('.', ',')) + '" required>' +
      '<div class="duas"><div><label>Forma</label><select name="method"><option>PIX</option><option>DINHEIRO</option><option>TRANSFERENCIA</option><option>OUTRO</option></select></div>' +
      '<div><label>Data do pagamento</label><input type="date" name="data" value="' + hojeYmd() + '" max="' + hojeYmd() + '"></div></div>' +
      '<label>Observação (opcional)</label><input name="nota" maxlength="200">' +
      '<div class="msg info small">Se o valor for maior que a parcela, o que sobrar abate as próximas parcelas.</div>' +
      '<div class="acoes"><button class="btn" type="submit" id="okBaixa">Confirmar baixa</button><button class="btn sec" type="button" id="cancBaixa">Cancelar</button></div></form>');
    $('cancBaixa').onclick = fecharModal;
    $('fBaixa').onsubmit = function (ev) {
      ev.preventDefault();
      var f = ev.target, valor = parseValor(f.valor.value);
      if (!(valor > 0)) { toast('Informe um valor maior que zero.', true); return; }
      $('okBaixa').disabled = true;
      var corpo = { amount: Math.round(valor * 100) / 100, method: f.method.value, paidAt: f.data.value || undefined, note: f.nota.value || undefined };
      api('/api/credito/parcelas/' + parcelaId + '/baixa', { method: 'POST', body: corpo }).then(function (r) {
        fecharModal();
        var extra = r.alocacoes && r.alocacoes.length > 1 ? ' (abateu ' + r.alocacoes.length + ' parcelas)' : '';
        toast('Baixa registrada: ' + money(r.recebido) + extra + (r.finished ? ' — contrato quitado! 🎉' : ''));
        limparCaches(); if (aoConcluir) aoConcluir();
      }).catch(function (e) { $('okBaixa').disabled = false; toast(e.message, true); });
    };
  }

  // ------------------------------------------------------------------ CLIENTES
  function telaClientes(_p, token) {
    $('app').innerHTML = '<div class="row"><h2>Clientes</h2><a class="btn sm" href="#/clientes/novo">+ Novo</a></div>' +
      '<input id="busca" type="search" placeholder="Buscar por nome ou CPF/CNPJ" autocomplete="off"><div id="lista" style="margin-top:12px"><div class="skel"></div></div>';
    function lista(d) {
      if (token !== state.rota) return;
      var h = '<div class="card">';
      if (!d.length) h = '<div class="card center muted">Nenhum cliente encontrado.</div>';
      d.forEach(function (c) {
        h += '<div class="item link" data-id="' + esc(c.id) + '"><div class="row"><div><b>' + esc(c.tradeName || c.name) + '</b><div class="muted small">' + esc(c.name !== (c.tradeName || c.name) ? c.name + ' · ' : '') + esc(c.city) + ' · ' + esc(c.segmentLabel) + '</div></div><div class="right">' + chip(ST_CLIENTE, c.status) + (c.level ? '<div class="muted small">' + esc(c.level.name) + '</div>' : '') + '</div></div></div>';
      });
      if (d.length) h += '</div>';
      $('lista').innerHTML = h;
    }
    var antigo = lerCache('clientes:'); if (antigo) lista(antigo);
    function buscar(q) {
      api('/api/credito/clientes' + (q ? '?q=' + encodeURIComponent(q) : '')).then(function (d) { if (!q) gravarCache('clientes:', d); lista(d); }).catch(function (e) { toast(e.message, true); });
    }
    buscar('');
    var t; $('busca').oninput = function (e) { clearTimeout(t); var q = e.target.value.trim(); t = setTimeout(function () { buscar(q); }, 250); };
    $('lista').onclick = function (e) { var i = e.target.closest('[data-id]'); if (i) location.hash = '#/clientes/' + i.getAttribute('data-id'); };
  }

  function carregarConfig() {
    if (state.cfg) return Promise.resolve(state.cfg);
    var c = lerCache('config'); if (c) state.cfg = c;
    return api('/api/credito/config').then(function (d) { state.cfg = d; gravarCache('config', d); return d; });
  }

  function telaClienteNovo(_p, token) {
    esqueleto();
    carregarConfig().then(function (cfg) {
      if (token !== state.rota) return;
      var seg = cfg.segments.map(function (s) { return '<option value="' + esc(s.key) + '">' + esc(s.label) + '</option>'; }).join('');
      $('app').innerHTML = '<h2>Novo cliente</h2><form class="card" id="fCli">' +
        '<div class="duas"><div><label>Tipo</label><select name="personType"><option value="PJ">Empresa / MEI (CNPJ)</option><option value="PF">Pessoa física (CPF)</option></select></div>' +
        '<div><label>CPF ou CNPJ</label><input name="document" inputmode="numeric" required></div></div>' +
        '<label>Nome completo / razão social</label><input name="name" required minlength="3">' +
        '<label>Nome fantasia (opcional)</label><input name="tradeName">' +
        '<label>WhatsApp (com DDD)</label><input name="whatsapp" inputmode="tel" required>' +
        '<div class="duas"><div><label>Cidade</label><input name="addressCity" required></div><div><label>UF</label><input name="addressState" maxlength="2" required style="text-transform:uppercase"></div></div>' +
        '<label>Ramo do negócio</label><select name="segment">' + seg + '</select>' +
        '<div class="duas"><div><label>Dias abertos por semana</label><input name="openDaysPerWeek" type="number" min="1" max="7" value="6"></div><div><label>Meses de atividade</label><input name="businessMonths" type="number" min="0" value="0"></div></div>' +
        '<label>Vendas por dia (R$, se souber)</label><input name="declaredDailySales" inputmode="decimal">' +
        '<label class="check" style="margin-top:12px"><input type="checkbox" name="ownsPoint"> Ponto comercial próprio</label>' +
        '<label class="check"><input type="checkbox" name="consent"> O cliente autorizou o uso dos dados (LGPD)</label>' +
        '<div class="acoes"><button class="btn" type="submit" id="okCli">Cadastrar</button><a class="btn sec" href="#/clientes">Cancelar</a></div></form>';
      $('fCli').onsubmit = function (ev) {
        ev.preventDefault(); var f = ev.target;
        if (!f.consent.checked) { toast('Marque a autorização de uso dos dados.', true); return; }
        var corpo = { personType: f.personType.value, document: digitos(f.document.value), name: f.name.value.trim(), whatsapp: f.whatsapp.value, addressCity: f.addressCity.value.trim(), addressState: f.addressState.value.trim().toUpperCase(),
          segment: f.segment.value, openDaysPerWeek: Number(f.openDaysPerWeek.value) || 6, businessMonths: Number(f.businessMonths.value) || 0, ownsPoint: f.ownsPoint.checked, consent: true };
        if (f.tradeName.value.trim()) corpo.tradeName = f.tradeName.value.trim();
        var vd = parseValor(f.declaredDailySales.value); if (vd > 0) corpo.declaredDailySales = vd;
        $('okCli').disabled = true;
        api('/api/credito/clientes', { method: 'POST', body: corpo }).then(function (r) { limparCaches(); toast('Cliente cadastrado.'); location.hash = '#/clientes/' + r.id; })
          .catch(function (e) { $('okCli').disabled = false; toast(e.message, true); });
      };
    }).catch(function (e) { $('app').innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; });
  }

  function telaCliente(p, token) {
    esqueleto();
    swr('cliente:' + p[1], '/api/credito/clientes/' + p[1], function (c) {
      if (token !== state.rota) return;
      var aberto = (c.contracts || []).some(function (k) { return ['DRAFT', 'AWAITING_SIGNATURE', 'SIGNED', 'ACTIVE'].indexOf(k.status) >= 0; });
      var h = '<a href="#/clientes" class="muted small">← Clientes</a><h2>' + esc(c.tradeName || c.name) + '</h2>';
      h += '<div class="card"><dl class="kv"><dt>Situação</dt><dd>' + chip(ST_CLIENTE, c.status) + '</dd><dt>Nome</dt><dd>' + esc(c.name) + '</dd><dt>' + (c.personType === 'PJ' ? 'CNPJ' : 'CPF') + '</dt><dd>' + esc(c.document) + '</dd>' +
        '<dt>WhatsApp</dt><dd>' + esc(c.whatsapp) + '</dd><dt>Cidade</dt><dd>' + esc(c.addressCity) + '/' + esc(c.addressState) + '</dd><dt>Ramo</dt><dd>' + esc(c.segmentLabel) + '</dd>' +
        '<dt>Nível</dt><dd>' + esc(c.level ? c.level.name : '—') + '</dd><dt>Ciclos pagos</dt><dd>' + esc(c.cyclesPaid) + '</dd>' +
        (c.capacity ? '<dt>Capacidade/dia</dt><dd>' + money(c.capacity.dailyCapacity) + '</dd>' : '') + '</dl>';
      h += '<div class="acoes">' + (aberto ? '<span class="chip warn">Já tem contrato em aberto</span>' : '<a class="btn" href="#/clientes/' + esc(c.id) + '/contrato">Novo contrato</a>') +
        '<a class="btn sm sec" target="_blank" rel="noopener" href="https://wa.me/' + esc(digitos(c.whatsapp)) + '">WhatsApp</a></div></div>';
      h += '<div class="card"><h3>Contratos</h3>';
      if (!(c.contracts || []).length) h += '<div class="muted">Nenhum contrato ainda.</div>';
      (c.contracts || []).forEach(function (k) {
        h += '<div class="item link" data-c="' + esc(k.id) + '"><div class="row"><div><b>' + esc(k.number) + '</b><div class="muted small">' + money(k.principal) + ' · ' + k.paid + '/' + k.installmentsCount + ' pagas</div></div><div class="right">' + chip(ST_CONTRATO, k.status) + '<div class="muted small">em aberto ' + money(k.outstanding) + '</div></div></div></div>';
      });
      h += '</div>';
      $('app').innerHTML = h;
      $('app').onclick = function (e) { var i = e.target.closest('[data-c]'); if (i) location.hash = '#/contratos/' + i.getAttribute('data-c'); };
    }, token);
  }

  // ------------------------------------------------------------------ NOVO CONTRATO (simular + gerar)
  function telaContratoNovo(p, token) {
    esqueleto();
    var id = p[1], quote = null;
    api('/api/credito/clientes/' + id).then(function (c) {
      if (token !== state.rota) return;
      $('app').innerHTML = '<a href="#/clientes/' + esc(id) + '" class="muted small">← ' + esc(c.tradeName || c.name) + '</a><h2>Novo contrato</h2>' +
        '<form class="card" id="fCt"><label>Valor a emprestar (R$) — deixe vazio para o sistema sugerir</label><input name="principal" inputmode="decimal" placeholder="ex.: 500">' +
        '<div class="duas"><div><label>Parcelas</label><input name="installments" type="number" min="2" max="120" value="22" required></div><div><label>Frequência</label><select name="frequency"><option value="DAILY">Diária</option><option value="WEEKLY">Semanal</option></select></div></div>' +
        '<div class="duas"><div><label>1º vencimento</label><input name="firstDueDate" type="date" value="' + amanhaYmd() + '" min="' + hojeYmd() + '"></div><div><label>Taxa % (opcional)</label><input name="ratePercent" inputmode="decimal" placeholder="do nível"></div></div>' +
        '<div class="acoes"><button class="btn" type="submit" id="btSim">Simular</button></div></form><div id="resultado"></div>';
      function corpo() {
        var f = $('fCt'), o = { borrowerId: id, installments: Number(f.installments.value), frequency: f.frequency.value, firstDueDate: f.firstDueDate.value };
        var v = parseValor(f.principal.value); if (v > 0) o.principal = v;
        var t = parseValor(f.ratePercent.value); if (t >= 0 && f.ratePercent.value !== '') o.ratePercent = t;
        return o;
      }
      $('fCt').onsubmit = function (ev) {
        ev.preventDefault(); $('btSim').disabled = true; $('resultado').innerHTML = '<div class="skel"></div>';
        api('/api/credito/simular', { method: 'POST', body: corpo() }).then(function (r) {
          $('btSim').disabled = false; quote = r; var q = r.quote;
          var h = '<div class="card"><h3>Simulação</h3><dl class="kv"><dt>Valor contratado</dt><dd>' + money(q.principal) + '</dd>' +
            (q.costs && q.costs.total ? '<dt>Cliente recebe</dt><dd>' + money(q.netToBorrower) + '</dd>' : '') +
            '<dt>Parcelas</dt><dd>' + q.installments + ' × ' + money(q.installmentAmount) + '</dd><dt>Total a pagar</dt><dd>' + money(q.totalPayable) + '</dd>' +
            '<dt>1º / último vencimento</dt><dd>' + dataBr(q.firstDueDate) + ' / ' + dataBr(q.lastDueDate) + '</dd><dt>Custo efetivo (CET)</dt><dd>' + esc(q.cetLabel) + '</dd></dl>';
          if (r.limite) h += '<div class="muted small" style="margin-top:8px">Sugestão do sistema: até ' + money(r.limite.valorSugerido) + '. ' + esc(r.limite.motivo || '') + '</div>';
          (r.alerts || []).forEach(function (a) { h += '<div class="msg warn small">' + esc(a) + '</div>'; });
          h += '<div class="acoes"><button class="btn" id="btGerar">Gerar contrato e link</button></div></div>';
          $('resultado').innerHTML = h;
          $('btGerar').onclick = function () {
            $('btGerar').disabled = true;
            var o = corpo(); o.principal = q.principal;
            api('/api/credito/contratos', { method: 'POST', body: o }).then(function (g) {
              limparCaches();
              var m = '<div class="card"><h3>Contrato ' + esc(g.number) + ' criado ✅</h3>' +
                (g.clienteRecorrente ? '<div class="msg ok small">Cliente recorrente: no link ele só toca em <b>Assinar</b>, sem fotos.</div>' : '<div class="msg info small">Cliente novo: no link ele envia os documentos e assina.</div>') +
                '<pre class="msgwa">' + esc(g.message) + '</pre><div class="acoes"><a class="btn" target="_blank" rel="noopener" href="' + esc(g.whatsappLink) + '">Enviar no WhatsApp</a>' +
                '<button class="btn sec" id="btCopiar">Copiar link</button><a class="btn sec" href="#/contratos/' + esc(g.id) + '">Abrir contrato</a></div>';
              (g.avisos || []).forEach(function (a) { m += '<div class="msg warn small">' + esc(a) + '</div>'; });
              $('resultado').innerHTML = m + '</div>';
              $('btCopiar').onclick = function () { copiar(g.link); };
            }).catch(function (e) { $('btGerar').disabled = false; toast(e.message, true); });
          };
        }).catch(function (e) { $('btSim').disabled = false; $('resultado').innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; });
      };
    }).catch(function (e) { $('app').innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; });
  }

  function copiar(texto) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(texto).then(function () { toast('Copiado.'); }, function () { toast('Não foi possível copiar.', true); });
    else { var t = document.createElement('textarea'); t.value = texto; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); toast('Copiado.'); } catch (e) { toast('Não foi possível copiar.', true); } document.body.removeChild(t); }
  }

  // ------------------------------------------------------------------ CONTRATOS
  function telaContratos(_p, token) {
    $('app').innerHTML = '<h2>Contratos</h2><select id="fSt"><option value="">Todos</option><option value="AWAITING_SIGNATURE">Aguardando assinatura</option><option value="ACTIVE">Em andamento</option><option value="DEFAULTED">Inadimplentes</option><option value="PAID">Quitados</option><option value="CANCELLED">Cancelados</option></select><div id="lista" style="margin-top:12px"><div class="skel"></div></div>';
    function lista(d) {
      if (token !== state.rota) return;
      var h = d.length ? '<div class="card">' : '<div class="card center muted">Nenhum contrato.</div>';
      d.forEach(function (c) {
        h += '<div class="item link" data-c="' + esc(c.id) + '"><div class="row"><div><b>' + esc(c.number) + '</b> · ' + esc(c.borrower.tradeName || c.borrower.name) + '<div class="muted small">' + money(c.principal) + ' · ' + c.paid + '/' + c.installmentsCount + ' pagas' + (c.overdue ? ' · <span style="color:var(--err)">' + c.overdue + ' atrasada(s)</span>' : '') + '</div></div><div class="right">' + chip(ST_CONTRATO, c.status) + '<div class="muted small">' + money(c.outstanding) + '</div></div></div></div>';
      });
      if (d.length) h += '</div>';
      $('lista').innerHTML = h;
    }
    function carregar(st) {
      var k = 'contratos:' + st, antigo = lerCache(k); if (antigo) lista(antigo);
      api('/api/credito/contratos' + (st ? '?status=' + st : '')).then(function (d) { gravarCache(k, d); lista(d); }).catch(function (e) { toast(e.message, true); });
    }
    carregar('');
    $('fSt').onchange = function (e) { carregar(e.target.value); };
    $('lista').onclick = function (e) { var i = e.target.closest('[data-c]'); if (i) location.hash = '#/contratos/' + i.getAttribute('data-c'); };
  }

  function telaContrato(p, token) {
    esqueleto();
    var id = p[1];
    function desenhar(c) {
      if (token !== state.rota) return;
      var ativo = c.status === 'ACTIVE' || c.status === 'DEFAULTED';
      var h = '<a href="#/contratos" class="muted small">← Contratos</a><h2>' + esc(c.number) + ' ' + chip(ST_CONTRATO, c.status) + '</h2>';
      h += '<div class="card"><dl class="kv"><dt>Cliente</dt><dd><a href="#/clientes/' + esc(c.borrower.id) + '">' + esc(c.borrower.tradeName || c.borrower.name) + '</a></dd>' +
        '<dt>Valor contratado</dt><dd>' + money(c.principal) + '</dd>' + (Number(c.costsTotal) > 0 ? '<dt>Cliente recebe</dt><dd>' + money(c.netToBorrower) + '</dd>' : '') +
        '<dt>Total a pagar</dt><dd>' + money(c.totalPayable) + '</dd><dt>Parcelas</dt><dd>' + c.installmentsCount + ' × ' + money(c.installmentAmount) + '</dd>' +
        (ativo ? '<dt>Falta receber hoje</dt><dd>' + money(c.aReceberHoje) + '</dd><dt>Já pago</dt><dd>' + money(c.totalPago) + '</dd>' : '') + '</dl></div>';

      if (c.status === 'AWAITING_SIGNATURE' && c.signature && c.signature.link) {
        h += '<div class="card"><h3>Aguardando assinatura</h3><div class="muted small" style="word-break:break-all">' + esc(c.signature.link) + '</div><div class="acoes"><button class="btn sm" id="btCopiar">Copiar link</button><button class="btn sm sec" id="btReenviar">Gerar link novo / WhatsApp</button></div><div id="reenvio"></div></div>';
      }
      if (ativo && !c.pixConfirmado) {
        h += '<div class="card"><h3>Enviar o Pix ao cliente</h3><div class="msg warn small">Envie <b>' + money(c.netToBorrower) + '</b> para a chave abaixo e depois confirme.</div>' +
          '<dl class="kv"><dt>Chave Pix</dt><dd>' + esc(c.receivePixKey || '—') + '</dd></dl><div class="acoes"><button class="btn sm sec" id="btCopiarPix">Copiar chave</button><button class="btn sm" id="btPix">Confirmei: Pix enviado</button></div></div>';
      }
      h += '<div class="card"><h3>Parcelas</h3>';
      var proxima = null;
      c.installments.forEach(function (i) { if (!proxima && i.status !== 'PAID' && i.status !== 'WAIVED') proxima = i.id; });
      c.installments.forEach(function (i) {
        // Botão de baixa só onde faz sentido: atrasadas, parciais e a próxima a vencer (pagar a próxima já abate as seguintes se sobrar valor).
        var aberta = i.status !== 'PAID' && i.status !== 'WAIVED';
        var pode = ativo && aberta && (i.status === 'OVERDUE' || i.status === 'PARTIAL' || i.id === proxima);
        h += '<div class="item"><div class="row"><div><b>' + i.sequence + 'ª</b> · ' + dataBr(i.dueDate) + '<div class="muted small">' + money(i.amountDue) + (Number(i.lateChargeHoje) > 0 && i.status !== 'PAID' ? ' + mora ' + money(i.lateChargeHoje) : '') + ' · pago ' + money(i.amountPaid) + '</div></div><div class="right">' + chip(ST_PARCELA, i.status) + (aberta ? '<div><b>' + money(i.faltaHoje) + '</b></div>' : '') + '</div></div>';
        if (pode) h += '<div class="acoes"><button class="btn sm" data-baixa="' + esc(i.id) + '" data-valor="' + esc(i.faltaHoje) + '" data-seq="' + i.sequence + '">Dar baixa</button></div>';
        (i.payments || []).forEach(function (pg) {
          h += '<div class="muted small row" style="margin-top:6px"><span>↳ ' + money(pg.amount) + ' em ' + dataBr(String(pg.paidAt).slice(0, 10)) + ' (' + esc(pg.method) + ')</span><button class="btn sm sec" data-estorno="' + esc(pg.id) + '" data-valor="' + esc(pg.amount) + '">Estornar</button></div>';
        });
        h += '</div>';
      });
      h += '</div>';
      if (c.status !== 'PAID' && c.status !== 'CANCELLED') h += '<button class="btn red full" id="btCancelar">Cancelar contrato</button>';
      $('app').innerHTML = h;

      var el;
      if ((el = $('btCopiar'))) el.onclick = function () { copiar(c.signature.link); };
      if ((el = $('btCopiarPix'))) el.onclick = function () { copiar(c.receivePixKey || ''); };
      if ((el = $('btReenviar'))) el.onclick = function () {
        el.disabled = true;
        api('/api/credito/contratos/' + id + '/reenviar', { method: 'POST', body: {} }).then(function (r) {
          $('reenvio').innerHTML = '<pre class="msgwa">' + esc(r.message) + '</pre><div class="acoes"><a class="btn sm" target="_blank" rel="noopener" href="' + esc(r.whatsappLink) + '">Enviar no WhatsApp</a><button class="btn sm sec" id="cp2">Copiar link novo</button></div>';
          $('cp2').onclick = function () { copiar(r.link); }; el.disabled = false;
        }).catch(function (e) { el.disabled = false; toast(e.message, true); });
      };
      if ((el = $('btPix'))) el.onclick = function () {
        el.disabled = true;
        api('/api/credito/contratos/' + id + '/confirmar-pix', { method: 'POST', body: {} }).then(function () { limparCaches(); toast('Pix confirmado.'); recarregar(); }).catch(function (e) { el.disabled = false; toast(e.message, true); });
      };
      if ((el = $('btCancelar'))) el.onclick = function () {
        abrirModal('<h3>Cancelar contrato ' + esc(c.number) + '?</h3><p class="muted">O cliente volta a ficar sem contrato e a saída do caixa (se já houve) é estornada. Não dá para cancelar contrato que já recebeu pagamento.</p>' +
          '<label>Motivo (opcional)</label><input id="motivo" maxlength="200" placeholder="ex.: cliente desistiu"><div class="acoes"><button class="btn red" id="okCancelar">Sim, cancelar</button><button class="btn sec" id="naoCancelar">Voltar</button></div>');
        $('naoCancelar').onclick = fecharModal;
        $('okCancelar').onclick = function () {
          $('okCancelar').disabled = true;
          api('/api/credito/contratos/' + id + '/cancelar', { method: 'POST', body: { reason: $('motivo').value.trim() } }).then(function () {
            fecharModal(); limparCaches(); toast('Contrato cancelado.'); recarregar();
          }).catch(function (e) { $('okCancelar').disabled = false; toast(e.message, true); });
        };
      };
      $('app').onclick = function (e) {
        var b = e.target.closest('[data-baixa]');
        if (b) return abrirBaixa(b.getAttribute('data-baixa'), b.getAttribute('data-valor'), c.number + ' · parcela ' + b.getAttribute('data-seq'), function () { recarregar(); });
        var s = e.target.closest('[data-estorno]');
        if (s) {
          abrirModal('<h3>Estornar pagamento de ' + money(s.getAttribute('data-valor')) + '?</h3><p class="muted">O valor sai do caixa e a parcela volta a ficar em aberto. Só o administrador pode estornar.</p><label>Motivo</label><input id="motivoE" maxlength="200" placeholder="ex.: lancei o valor errado"><div class="acoes"><button class="btn red" id="okEst">Estornar</button><button class="btn sec" id="noEst">Voltar</button></div>');
          $('noEst').onclick = fecharModal;
          $('okEst').onclick = function () {
            var m = $('motivoE').value.trim(); if (m.length < 3) { toast('Explique o motivo (mínimo 3 letras).', true); return; }
            $('okEst').disabled = true;
            api('/api/credito/pagamentos/' + s.getAttribute('data-estorno') + '/estornar', { method: 'POST', body: { motivo: m } }).then(function (r) { fecharModal(); limparCaches(); toast('Estornado.' + (r.aviso ? ' ' + r.aviso : '')); recarregar(); }).catch(function (er) { $('okEst').disabled = false; toast(er.message, true); });
          };
        }
      };
    }
    function recarregar() { api('/api/credito/contratos/' + id).then(function (c) { gravarCache('contrato:' + id, c); desenhar(c); }).catch(function (e) { toast(e.message, true); }); }
    swr('contrato:' + id, '/api/credito/contratos/' + id, desenhar, token);
  }

  // ------------------------------------------------------------------ CAIXA
  function telaCaixa(_p, token) {
    esqueleto();
    function desenhar(d) {
      if (token !== state.rota) return;
      var h = '<h2>Caixa</h2><div class="grid"><div class="kpi destaque"><small>Saldo em caixa</small><b>' + money(d.saldo) + '</b></div>' +
        '<div class="kpi"><small>Disponível p/ emprestar</small><b>' + money(d.situacao.disponivelParaEmprestar) + '</b></div><div class="kpi"><small>Reserva guardada</small><b>' + money(d.situacao.reservaGuardada) + '</b></div></div>';
      h += '<form class="card" id="fCx"><h3>Novo lançamento</h3><div class="duas"><div><label>Tipo</label><select name="kind"><option value="APORTE">Aporte (entrou dinheiro seu)</option><option value="RETIRADA">Retirada</option><option value="DESPESA">Despesa</option></select></div>' +
        '<div><label>Valor (R$)</label><input name="amount" inputmode="decimal" required></div></div><label>Descrição</label><input name="description" required minlength="3" maxlength="200"><div class="acoes"><button class="btn" id="okCx" type="submit">Lançar</button></div></form>';
      h += '<div class="card"><h3>Últimos lançamentos</h3>';
      d.lancamentos.forEach(function (l) {
        var n = Number(l.amount);
        h += '<div class="item"><div class="row"><div>' + esc(l.description) + '<div class="muted small">' + esc(l.kind) + ' · ' + dataBr(String(l.happenedAt).slice(0, 10)) + '</div></div><b style="color:' + (n < 0 ? 'var(--err)' : 'var(--ok)') + '">' + money(n) + '</b></div></div>';
      });
      h += '</div>';
      $('app').innerHTML = h;
      $('fCx').onsubmit = function (ev) {
        ev.preventDefault(); var f = ev.target, v = parseValor(f.amount.value);
        if (!(v > 0)) { toast('Informe um valor maior que zero.', true); return; }
        $('okCx').disabled = true;
        api('/api/credito/caixa', { method: 'POST', body: { kind: f.kind.value, amount: v, description: f.description.value.trim() } }).then(function () { limparCaches(); toast('Lançado.'); telaCaixa(null, token); })
          .catch(function (e) { $('okCx').disabled = false; toast(e.message, true); });
      };
    }
    swr('caixa', '/api/credito/caixa?limit=40', desenhar, token);
  }

  // ------------------------------------------------------------------ CONFIGURAÇÕES
  function telaConfig(_p, token) {
    esqueleto();
    api('/api/credito/config').then(function (cfg) {
      if (token !== state.rota) return;
      state.cfg = cfg; var s = cfg.settings;
      function campo(nome, rot, tipo) { return '<label>' + rot + '</label><input name="' + nome + '" ' + (tipo === 'num' ? 'inputmode="decimal"' : '') + ' value="' + esc(s[nome] == null ? '' : s[nome]) + '">'; }
      var h = '<h2>Configurações</h2><form class="card" id="fCf"><h3>Empresa e Pix</h3>' + campo('companyName', 'Nome da empresa') + campo('companyDocument', 'CNPJ') + campo('companyAddress', 'Endereço') +
        campo('pixKey', 'Chave Pix que recebe as parcelas') + campo('pixOwner', 'Nome do titular do Pix') +
        '<h3 style="margin-top:16px">Regras</h3><div class="duas"><div>' + campo('minPrincipal', 'Valor mínimo (R$)', 'num') + '</div><div>' + campo('maxPrincipalGlobal', 'Valor máximo (R$)', 'num') + '</div></div>' +
        '<div class="duas"><div>' + campo('lateFeePercent', 'Multa por atraso (%)', 'num') + '</div><div>' + campo('lateDailyPercent', 'Juros de mora ao dia (%)', 'num') + '</div></div>' +
        '<div class="acoes"><button class="btn" id="okCf" type="submit">Salvar</button></div><div class="muted small" style="margin-top:8px">Só o administrador pode salvar.</div></form>';
      h += '<div class="card"><h3>Níveis de crédito</h3>';
      cfg.levels.forEach(function (l) { h += '<div class="item row"><span>' + esc(l.name) + '</span><span class="muted small">até ' + money(l.maxPrincipal) + ' · ' + esc(l.ratePercent) + '%</span></div>'; });
      h += '</div><div class="card"><h3>Conferência da carteira</h3><div class="muted small">Compara parcelas, saldo e caixa com os pagamentos registrados e mostra qualquer diferença.</div><div class="acoes"><button class="btn sec" id="btConf">Conferir agora</button></div><div id="confRes"></div></div>';
      $('app').innerHTML = h;
      $('fCf').onsubmit = function (ev) {
        ev.preventDefault(); var f = ev.target, o = {};
        ['companyName', 'companyDocument', 'companyAddress', 'pixKey', 'pixOwner'].forEach(function (k) { if (f[k].value.trim() !== '') o[k] = f[k].value.trim(); });
        ['minPrincipal', 'maxPrincipalGlobal', 'lateFeePercent', 'lateDailyPercent'].forEach(function (k) { var v = parseValor(f[k].value); if (!isNaN(v)) o[k] = v; });
        $('okCf').disabled = true;
        api('/api/credito/config', { method: 'PUT', body: o }).then(function () { state.cfg = null; limparCaches(); toast('Configurações salvas.'); $('okCf').disabled = false; })
          .catch(function (e) { $('okCf').disabled = false; toast(e.message, true); });
      };
      $('btConf').onclick = function () {
        $('btConf').disabled = true; $('confRes').innerHTML = '<div class="skel"></div>';
        api('/api/credito/conferir', { method: 'POST' }).then(function (r) {
          $('btConf').disabled = false;
          $('confRes').innerHTML = r.tudoCerto ? '<div class="msg ok">Tudo certo: ' + r.contratosConferidos + ' contrato(s) conferido(s), nenhuma diferença.</div>'
            : '<div class="msg warn">' + r.divergencias.length + ' diferença(s):</div>' + r.divergencias.map(function (d) { return '<div class="small item"><b>' + esc(d.contrato) + '</b> — ' + esc(d.detalhe) + '</div>'; }).join('');
        }).catch(function (e) { $('btConf').disabled = false; $('confRes').innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; });
      };
    }).catch(function (e) { $('app').innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; });
  }

  // ------------------------------------------------------------------ partida
  $('btnEntrar').onclick = entrar;
  $('btnSair').onclick = sair;
  $('btnConfig').onclick = function () { location.hash = '#/config'; };
  window.addEventListener('hashchange', function () { fecharModal(); if (state.user) rota(); });

  function aposLogin(user) {
    state.user = user;
    try { localStorage.setItem('mc:logado', '1'); } catch (e) { /* nada */ }
    mostrarShell();
    // Pré-carrega a configuração em segundo plano (vários formulários usam).
    carregarConfig().catch(function () { /* o login pode não ser operador: a tela mostra o erro */ });
    if (!state.rotaIniciada) { state.rotaIniciada = true; rota(); }
  }

  function iniciar() {
    // Se o aparelho já estava logado, mostra o painel com os últimos dados IMEDIATAMENTE, antes do Firebase carregar.
    var estavaLogado = false; try { estavaLogado = localStorage.getItem('mc:logado') === '1'; } catch (e) { /* nada */ }
    if (estavaLogado) {
      mostrarShell(); var cfg0 = lerCache('config'); if (cfg0) state.cfg = cfg0;
      state.user = {}; state.rotaIniciada = true; rota(); // tela com os dados guardados, sem esperar o Firebase
    }
    if (!iniciarFirebase()) { resolverAuth(); if (!estavaLogado) mostrarLogin(window.__FB && window.__FB.apiKey ? 'Não consegui carregar o login do Google. Verifique a internet.' : 'A configuração do login (chave do Firebase) ainda não foi definida no servidor.'); return; }
    auth.onAuthStateChanged(function (u) {
      resolverAuth();
      if (u) aposLogin(u); else { state.user = null; state.rotaIniciada = false; mostrarLogin(''); }
    });
  }

  // Os scripts do Firebase carregam com "defer"; quando o DOM terminar eles já existem.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
