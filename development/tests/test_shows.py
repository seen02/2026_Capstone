import copy
import json
import random
import unittest
from pathlib import Path
from aquarium_sim.engine import Simulation,Visitor,clock_seconds

ROOT=Path(__file__).resolve().parents[1]
MAP=json.loads((ROOT/'configs/aquarium_map.json').read_text(encoding='utf-8'))
CONFIG=json.loads((ROOT/'configs/day.json').read_text(encoding='utf-8'))

class ShowTests(unittest.TestCase):
    def empty_show(self,zone):
        cfg=copy.deepcopy(CONFIG);cfg['daily_visitors']=0
        sim=Simulation(MAP,cfg)
        show=next(s for s in sim.shows.values() if s.zone==zone)
        sim.advance_to(show.queue_open)
        return sim,show

    def join(self,sim,show,id,deadline=None):
        a=Visitor(id,2,sim.now,deadline or sim.closing,random.Random(id),
                  node=sim.graph.nodes[show.zone]['queue_node'],destination=show.zone,show_id=show.key)
        sim.active[id]=a;sim.entered+=1
        sim._push(a.deadline,'deadline',id)
        sim._join_show(a)
        return a

    def test_venue_waiting_locations_and_capacity(self):
        for zone,capacity in [('A',50),('B',80),('F',50)]:
            with self.subTest(zone=zone):
                sim,show=self.empty_show(zone)
                visitors=[self.join(sim,show,i) for i in range(1,capacity+2)]
                self.assertEqual(len(show.reserved),capacity)
                self.assertEqual(sum(a.state=='queueing' for a in visitors),capacity if zone=='F' else 0)
                rejected=visitors[-1]
                self.assertNotEqual(rejected.destination,zone)
                self.assertIn(rejected.id,show.full)
                sim.advance_to(show.admission_open-.01)
                self.assertEqual(sim.occupancy[zone],0 if zone=='F' else capacity)
                if zone!='F':
                    self.assertTrue(all(a.state=='show_waiting' and a.node==zone and not a.edge for a in visitors[:-1]))
                    self.assertFalse(show.queue)
                sim.advance_to(show.start)
                self.assertEqual(sim.occupancy[zone],capacity)
                # 정원은 입장 때 확보하지만 실제 보행·대기로 착석은 늦어질 수 있다.
                self.assertLessEqual(len(show.attended),capacity)
                sim.advance_to(show.start+180)
                self.assertEqual(len(show.attended),capacity)
                self.assertTrue(all(sim.active[i].state=='viewing' for i in show.reserved))
                sim.advance_to(show.end)
                self.assertEqual(len(show.completed),capacity)
                self.assertFalse(show.reserved)
                self.assertTrue(all(a.visits[0]['end']==show.end for a in visitors[:-1]))
                sim.advance_to(sim.horizon)
                self.assertFalse(sim.active)
                self.assertTrue(all(v==0 for v in sim.occupancy.values()))

    def test_current_gallery_visitors_keep_position_even_at_capacity(self):
        for zone in ['A','B']:
            with self.subTest(zone=zone):
                sim,show=self.empty_show(zone)
                a=Visitor(999,0,sim.now,sim.closing,random.Random(999),node=zone,
                          destination=zone,state='viewing',admitted_zone=zone,
                          visits=[dict(node=zone,start=sim.now-60,end=None)])
                sim.active[a.id]=a;sim.occupancy[zone]=1
                for i in range(1,show.capacity):self.join(sim,show,i)
                self.assertEqual(sim._used_capacity(zone),show.capacity)
                self.assertTrue(sim._has_show_space(a,show))
                sim._target_show(a,show)
                self.assertEqual(a.node,zone)
                self.assertEqual(a.state,'show_waiting')
                self.assertIsNone(a.edge)
                self.assertFalse(a.route)
                self.assertEqual(sim._used_capacity(zone),show.capacity)
                self.assertEqual(len(show.reserved),show.capacity)
                sim.advance_to(show.start)
                self.assertEqual(a.state,'viewing')
                self.assertEqual(a.node,zone)
                self.assertEqual(a.visits[-1]['show'],show.key)
                self.assertGreater(a.wait_seconds,0)

    def test_gallery_wait_deadline_releases_position_and_reservation(self):
        sim,show=self.empty_show('A');a=self.join(sim,show,1)
        sim.advance_to(show.queue_open+60)
        self.assertEqual(a.state,'show_waiting')
        sim._deadline(a)
        self.assertNotIn(a.id,show.reserved)
        self.assertEqual(sim.occupancy['A'],0)
        sim.advance_to(sim.horizon)
        self.assertFalse(sim.active)
        self.assertNotIn(a.id,show.attended)

    def test_f_exit_door_is_traversed_before_next_exhibit(self):
        sim,show=self.empty_show('F');a=self.join(sim,show,1)
        sim.advance_to(show.start);self.assertEqual(a.state,'viewing')
        sim.advance_to(show.end)
        self.assertFalse(a.must_exit)
        self.assertIn(a.destination,'ABCDE')
        path=[a.next_node]+[n for n,_ in a.route]
        self.assertIn('show_out_1',path)
        self.assertNotIn('show_gate',path)
        seen=[]
        for _ in range(400):
            sim.advance_to(sim.now+1);seen.append(a.node)
            if a.state=='viewing':break
        self.assertIn('show_out_1',seen)
        self.assertEqual(a.state,'viewing')
        self.assertNotEqual(a.node,'F')

    def test_deadline_releases_queue_seat_without_admitting_early(self):
        sim,show=self.empty_show('F')
        a=self.join(sim,show,1)
        sim.advance_to(sim.now+10);sim._deadline(a)
        self.assertNotIn(a.id,show.reserved)
        self.assertNotIn(a.id,show.queue)
        self.assertEqual(a.destination,'exit')
        self.assertGreater(a.wait_seconds,0)
        b=self.join(sim,show,2)
        self.assertIn(b.id,show.reserved)
        sim.advance_to(show.start)
        self.assertNotIn(a.id,show.attended)
        self.assertIn(b.id,show.attended)

    def test_deadline_during_boarding_and_seated_wait_releases_all_capacity(self):
        for phase in ['walking','seated']:
            with self.subTest(phase=phase):
                sim,show=self.empty_show('F');a=self.join(sim,show,1)
                sim.advance_to(show.admission_open+1)
                if phase=='seated':
                    for _ in range(100):
                        if a.state=='seated':break
                        sim.advance_to(sim.now+1)
                self.assertEqual(a.state,phase)
                self.assertEqual(sim.occupancy['F'],1)
                sim._deadline(a)
                sim.advance_to(show.end)
                self.assertNotIn(a.id,show.reserved)
                self.assertNotIn(a.id,show.attended)
                self.assertEqual(sim.occupancy['F'],0)
                self.assertTrue(all(n>=0 for n in sim.edge_load.values()))

    def test_start_cutoff_and_insufficient_stay_choose_alternative(self):
        sim,show=self.empty_show('F')
        short=self.join(sim,show,1,deadline=show.end-1)
        self.assertNotEqual(short.destination,'F')
        sim.advance_to(show.start)
        late=self.join(sim,show,2)
        self.assertNotEqual(late.destination,'F')
        self.assertEqual(show.missed,{1,2})
        self.assertFalse(show.reserved)

    def test_regular_gallery_and_show_reservations_share_capacity(self):
        for zone in ['A','B']:
            sim,show=self.empty_show(zone)
            # 진행 중인 일반 관람객 한 명의 자리는 공연 대기로 중복 판매하지 않는다.
            normal=Visitor(999,0,sim.now,sim.closing,random.Random(999),node=zone,
                           destination=zone,state='viewing',admitted_zone=zone,
                           visits=[dict(node=zone,start=sim.now,end=None)])
            sim.active[normal.id]=normal;sim.occupancy[zone]=1
            for i in range(1,show.capacity+1):self.join(sim,show,i)
            self.assertEqual(len(show.reserved),show.capacity-1)
            self.assertEqual(sim._used_capacity(zone),show.capacity)
            self.assertIn(show.capacity,show.full)

    def test_announcement_redirects_after_current_edge_without_teleport(self):
        cfg=copy.deepcopy(CONFIG);cfg['daily_visitors']=0
        sim=Simulation(MAP,cfg);show=sim.shows['F@10:20']
        sim.advance_to(show.queue_open-1)
        a=Visitor(1,2,sim.now,sim.closing,random.Random(1),node='entry',destination='A')
        sim.active[1]=a
        _,prev=sim.graph.routes(a.node);a.route=sim.graph.path(prev,'entry','queue_A');sim._walk(a)
        end=a.move_end;edge=a.edge
        sim._target_show(a,show)
        self.assertEqual(a.edge,edge);self.assertEqual(a.move_end,end)
        self.assertTrue(a.redirect_show)
        sim.advance_to(end)
        self.assertEqual(a.node,'lobby')
        self.assertEqual(a.destination,'F')
        self.assertFalse(a.redirect_show)

    def test_daily_shows_and_step_independence(self):
        sim=Simulation(MAP,CONFIG)
        sim.advance_to(sim.horizon)
        rows=sim.snapshot()['shows']
        self.assertEqual(len(rows),12)
        self.assertTrue(all(r['attended']>0 for r in rows))
        self.assertTrue(all(r['attended']==r['completed'] for r in rows))
        self.assertTrue(all(r['peak_reserved']<=r['capacity'] for r in rows))
        self.assertTrue(any(r['node']=='F' and r['peak_reserved']==50 and r['full_redirects']>0 for r in rows))
        self.assertEqual(sim.exited,CONFIG['daily_visitors'])
        self.assertTrue(all(not s.reserved for s in sim.shows.values()))
        stepped=Simulation(MAP,CONFIG)
        while stepped.now<stepped.horizon:stepped.advance_to(min(stepped.horizon,stepped.now+137))
        self.assertEqual(sim.report(),stepped.report())

    def test_f_is_not_a_regular_exhibit_between_performances(self):
        sim=Simulation(MAP,CONFIG)
        sim.advance_to(clock_seconds('09:45'))
        self.assertEqual(sim.occupancy['F'],0)
        self.assertFalse(any(a.destination=='F' for a in sim.active.values()))

if __name__=='__main__':unittest.main()
